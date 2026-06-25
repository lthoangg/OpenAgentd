from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable
from uuid import UUID

import yaml
from loguru import logger
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, MemoryProcessedSource
from app.services.memory import WIKI_DIR, seed_memory, write_memory_file
from app.services.wiki import INDEX_FILE, NOTES_DIR, append_log, wiki_root

_MEMORY_TOPIC_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "assistant",
    "by",
    "content",
    "dream",
    "from",
    "is",
    "it",
    "of",
    "or",
    "raw",
    "source",
    "the",
    "to",
    "user",
    "with",
}
_MEMORY_TOPIC_ALIASES = {
    "answer": "response-style",
    "answers": "response-style",
    "answering": "response-style",
    "direct": "response-style",
    "detailed": "response-style",
    "fact": "response-style",
    "facts": "response-style",
    "respond": "response-style",
    "response": "response-style",
    "responses": "response-style",
    "personalization": "personalization",
    "personalisation": "personalization",
    "preference": "preferences",
    "preferences": "preferences",
    "prefer": "preferences",
    "preferred": "preferences",
    "prefers": "preferences",
}
_CURATED_PAGE_SPECS = {
    "user": {
        "title": "User",
        "description": "Curated durable user preferences and profile memory.",
        "memory_kind": "profile",
        "scope": "user",
        "topics": ["preferences", "response-style", "personalization"],
    },
    "openagentd": {
        "title": "OpenAgentd",
        "description": "Curated durable OpenAgentd project context.",
        "memory_kind": "project_context",
        "scope": "project",
        "topics": ["openagentd", "project", "stack", "memory"],
    },
    "memory-v2": {
        "title": "Memory v2",
        "description": "Curated durable Memory v2 and Dream design decisions.",
        "memory_kind": "memory_system",
        "scope": "project",
        "topics": ["memory", "dream", "retrieval", "evals", "karpathy"],
    },
}
_CURATED_SOURCE_PREFIXES = ("session-", "note-entry-", "import-")
_NOISE_RE = re.compile(
    r"\b(do not remember|don't remember|forget this|secret|password|api[_ -]?key|token)\b",
    re.IGNORECASE,
)
_DURABLE_RE = re.compile(
    r"\b(prefers?|wants?|uses?|main project|memory v2|dream|openagentd|karpathy|longmemeval|locomo|turbovec|migration)\b",
    re.IGNORECASE,
)
_BOILERPLATE_RE = re.compile(
    r"\b(source_type|source_id|content_hash|compiled by dream|raw source|confidence=|sources?:|updated:)\b",
    re.IGNORECASE,
)
_CITATION_RE = re.compile(r"\[(session:[^\]]+|note:[^\]]+|import:[^\]]+)\]")
_FACT_ID_RE = re.compile(r"\bfact_id=([a-z0-9-]+)\b")
_NOTE_ENTRY_HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")
_NOTE_ENTRY_TIMESTAMP_RE = re.compile(r"\b\d{1,2}:\d{2}\b|\b\d{4}-\d{2}-\d{2}T\S+")


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_note_entries(filename: str, content: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    current_heading: str | None = None
    current_lines: list[str] = []

    def _flush() -> None:
        nonlocal current_heading, current_lines
        if current_heading is None:
            return
        body = "\n".join(current_lines).strip()
        entry_text = f"{current_heading}\n\n{body}".strip()
        digest = _hash_text(entry_text)
        slug = re.sub(r"[^a-z0-9]+", "-", current_heading.lower()).strip("-")
        entries.append(
            {
                "source_id": f"{filename}#{slug}",
                "filename": filename,
                "heading": current_heading,
                "content": body,
                "content_hash": digest,
            }
        )
        current_heading = None
        current_lines = []

    for line in content.splitlines():
        match = _NOTE_ENTRY_HEADING_RE.match(line)
        if match and _NOTE_ENTRY_TIMESTAMP_RE.search(match.group(1)):
            _flush()
            current_heading = match.group(1).strip()
            current_lines = []
            continue
        if current_heading is not None:
            current_lines.append(line)
    _flush()
    return entries


def hash_import_source(path: Path) -> str:
    return _hash_text(path.read_text(encoding="utf-8"))


async def get_pending_memory_sources(
    db: AsyncSession,
    *,
    dream_agent_name: str,
    hash_session_source: Callable[[AsyncSession, UUID], Awaitable[str]],
) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []

    session_stmt = select(ChatSession).where(
        col(ChatSession.agent_name) != dream_agent_name,
    )
    for session in (await db.exec(session_stmt)).all():
        candidates.append(
            {
                "source_type": "session",
                "source_id": str(session.id),
                "content_hash": await hash_session_source(db, session.id),
            }
        )

    root = wiki_root()
    notes_dir = root / NOTES_DIR
    if notes_dir.is_dir():
        for path in sorted(notes_dir.glob("*.md")):
            try:
                entries = parse_note_entries(
                    path.name, path.read_text(encoding="utf-8")
                )
            except OSError:
                continue
            for entry in entries:
                candidates.append(
                    {
                        "source_type": "note_entry",
                        "source_id": entry["source_id"],
                        "content_hash": entry["content_hash"],
                    }
                )

    imports_dir = root / "imports"
    if imports_dir.is_dir():
        for path in sorted(imports_dir.glob("*.md")):
            try:
                content_hash = hash_import_source(path)
            except OSError:
                continue
            candidates.append(
                {
                    "source_type": "import",
                    "source_id": path.stem,
                    "content_hash": content_hash,
                }
            )

    if not candidates:
        return []

    stmt = select(MemoryProcessedSource).where(
        col(MemoryProcessedSource.source_type).in_(
            {c["source_type"] for c in candidates}
        )
    )
    rows = (await db.exec(stmt)).all()
    processed = {(row.source_type, row.source_id): row for row in rows}
    return [
        c
        for c in candidates
        if (row := processed.get((c["source_type"], c["source_id"]))) is None
        or row.content_hash != c["content_hash"]
        or row.status == "failed"
    ]


def _memory_page_slug(source_type: str, source_id: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", f"{source_type}-{source_id}".lower()).strip("-")
    return slug[:120] or "source"


def _memory_topics(text: str) -> list[str]:
    counts: dict[str, int] = {}
    for raw in re.findall(r"[a-z0-9]+", text.lower()):
        token = _MEMORY_TOPIC_ALIASES.get(raw, raw)
        if token in _MEMORY_TOPIC_STOPWORDS or len(token) < 3:
            continue
        if raw in {"hoang", "openagentd", "kubernetes"}:
            token = raw
        counts[token] = counts.get(token, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return sorted(token for token, _count in ranked[:8])


def _memory_metadata(source: dict[str, str], source_text: str) -> dict[str, object]:
    source_type = source["source_type"]
    topics = _memory_topics(source_text)
    return {
        "memory_kind": {
            "session": "conversation",
            "note_entry": "note",
            "import": "import",
        }.get(source_type, "source"),
        "scope": source_type,
        "topics": topics,
    }


def _canonical_fact_key(statement: str) -> str:
    statement = _CITATION_RE.sub(" ", statement)
    statement = re.sub(r"\bconfidence=\w+\b", " ", statement, flags=re.IGNORECASE)
    statement = _FACT_ID_RE.sub(" ", statement)
    statement = re.sub(
        r"\b(Hoang|the user) (now )?(prefers?|wants?|uses?)\b",
        r"user \3",
        statement,
        flags=re.IGNORECASE,
    )
    statement = re.sub(
        r"\b(OpenAgentd|Memory v2) (now )?(uses?|is|has|requires?)\b",
        r"\1 \3",
        statement,
        flags=re.IGNORECASE,
    )
    words = [
        _MEMORY_TOPIC_ALIASES.get(token, token)
        for token in re.findall(r"[a-z0-9]+", statement.lower())
        if token not in _MEMORY_TOPIC_STOPWORDS
    ]
    if any(word in words for word in ("preferences", "wants", "want")):
        words = [word for word in words if word not in {"now"}]
        return " ".join(words[:4])
    return " ".join(words[:8])


def _fact_id(statement: str) -> str:
    digest = hashlib.sha256(_canonical_fact_key(statement).encode("utf-8")).hexdigest()
    return digest[:12]


def _memory_page_content(
    source: dict[str, str],
    source_text: str,
    *,
    max_prompt_chars: int,
) -> str:
    source_ref = f"{source['source_type']}:{source['source_id']}"
    title = source_ref.replace("#", " #")
    body = source_text.strip() or "(empty source)"
    if len(body) > max_prompt_chars:
        body = body[:max_prompt_chars] + "\n\n[... source truncated ...]"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    metadata = _memory_metadata(source, source_text)
    metadata_yaml = yaml.safe_dump(metadata, sort_keys=False).strip()
    return (
        "---\n"
        f"description: Dream v2 compiled memory for {source_ref}\n"
        f"updated: {today}\n"
        "tags: [memory-v2, dream]\n"
        f"{metadata_yaml}\n"
        "confidence: medium\n"
        "sources:\n"
        f"  - {source_ref}\n"
        "---\n\n"
        f"# {title}\n\n"
        "Compiled by Dream from the cited raw source.\n\n"
        "## Source\n\n"
        f"- source_type: `{source['source_type']}`\n"
        f"- source_id: `{source['source_id']}`\n"
        f"- content_hash: `{source['content_hash']}`\n\n"
        "## Content\n\n"
        f"{body}\n"
    )


def _load_curated_page(slug: str) -> dict[str, set[str]]:
    path = wiki_root() / WIKI_DIR / f"{slug}.md"
    if not path.is_file():
        return {"facts": set(), "conflicts": set(), "ignored": set()}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {"facts": set(), "conflicts": set(), "ignored": set()}
    sections: dict[str, set[str]] = {
        "facts": set(),
        "conflicts": set(),
        "ignored": set(),
    }
    current: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "## Facts":
            current = "facts"
            continue
        if stripped == "## Conflicts / stale candidates":
            current = "conflicts"
            continue
        if stripped == "## Ignored source notes":
            current = "ignored"
            continue
        if stripped.startswith("## "):
            current = None
            continue
        if current and stripped.startswith("- "):
            sections[current].add(stripped)
    return sections


def _source_refs_for_curated_page(
    slug: str, sections: dict[str, set[str]]
) -> list[str]:
    refs: set[str] = set()
    for lines in sections.values():
        for line in lines:
            refs.update(
                re.findall(r"\[(session:[^\]]+|note:[^\]]+|import:[^\]]+)\]", line)
            )
    source_slug_prefixes = tuple(
        f"wiki:{prefix}" for prefix in _CURATED_SOURCE_PREFIXES
    )
    path = wiki_root() / WIKI_DIR / f"{slug}.md"
    if path.is_file():
        try:
            existing = yaml.safe_load(
                path.read_text(encoding="utf-8").split("---", 2)[1]
            )
        except Exception:
            existing = None
        if isinstance(existing, dict) and isinstance(existing.get("sources"), list):
            for item in existing["sources"]:
                text = str(item).strip()
                if text and not text.startswith(source_slug_prefixes):
                    refs.add(text)
    return sorted(refs)


def _write_curated_page(slug: str, sections: dict[str, set[str]]) -> bool:
    spec = _CURATED_PAGE_SPECS[slug]
    refs = _source_refs_for_curated_page(slug, sections)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    frontmatter = {
        "description": spec["description"],
        "updated": today,
        "tags": ["memory-v2", "dream", "curated"],
        "memory_kind": spec["memory_kind"],
        "scope": spec["scope"],
        "topics": spec["topics"],
        "confidence": "medium" if sections["facts"] else "low",
        "sources": refs,
    }
    lines = [
        "---",
        yaml.safe_dump(frontmatter, sort_keys=False).strip(),
        "---",
        "",
        f"# {spec['title']}",
        "",
        "Curated by Dream from durable Memory v2 source pages. Active facts are cited bullets with stable `fact_id=...` markers.",
        "",
        "## Facts",
        "",
    ]
    lines.extend(sorted(sections["facts"]) or ["- (none yet)"])
    lines.extend(["", "## Conflicts / stale candidates", ""])
    lines.extend(sorted(sections["conflicts"]) or ["- (none recorded)"])
    lines.extend(["", "## Ignored source notes", ""])
    lines.extend(sorted(sections["ignored"]) or ["- (none recorded)"])
    content = "\n".join(lines) + "\n"
    path = wiki_root() / WIKI_DIR / f"{slug}.md"
    old = path.read_text(encoding="utf-8") if path.is_file() else None
    if old == content:
        return False
    write_memory_file(f"{WIKI_DIR}/{slug}.md", content)
    return True


def _statement_lines(text: str) -> list[str]:
    content = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    content = re.sub(r"`[^`]+`", " ", content)
    lines: list[str] = []
    for raw in content.splitlines():
        stripped = raw.strip().strip("-* ")
        if not stripped or stripped.startswith(("#", "Source-", "Agent:", "Date:")):
            continue
        if _BOILERPLATE_RE.search(stripped):
            continue
        for part in re.split(r"(?<=[.!?])\s+", stripped):
            sentence = " ".join(part.split()).strip()
            if 12 <= len(sentence) <= 260 and not _BOILERPLATE_RE.search(sentence):
                lines.append(sentence.rstrip("."))
    return lines


def _curated_page_for_statement(statement: str) -> str | None:
    lower = statement.lower()
    if "hoang" in lower and any(
        term in lower for term in ("prefers", "prefer", "wants", "want")
    ):
        return "user"
    if "openagentd" in lower:
        if "memory v2" in lower or "dream" in lower or "karpathy" in lower:
            return "memory-v2"
        return "openagentd"
    if any(
        term in lower
        for term in (
            "memory v2",
            "dream",
            "karpathy",
            "longmemeval",
            "locomo",
            "turbovec",
            "migration",
        )
    ):
        return "memory-v2"
    if any(
        term in lower for term in ("prefers", "prefer", "wants", "want", "main project")
    ):
        return "user"
    return None


def _merged_fact_line(existing_line: str, source_ref: str) -> str:
    refs = set(_CITATION_RE.findall(existing_line))
    if source_ref in refs:
        return existing_line
    refs.add(source_ref)
    merged_refs = " ".join(f"[{ref}]" for ref in sorted(refs))
    fact_id_match = _FACT_ID_RE.search(existing_line)
    fact_id = fact_id_match.group(1) if fact_id_match else _fact_id(existing_line)
    base = _CITATION_RE.sub("", existing_line).replace(" confidence=medium", "")
    base = _FACT_ID_RE.sub("", base)
    return f"{' '.join(base.split())} {merged_refs} confidence=medium fact_id={fact_id}"


def _fact_line(statement: str, source_ref: str) -> str:
    statement = statement.rstrip(".")
    return (
        f"- {statement}. [{source_ref}] confidence=medium fact_id={_fact_id(statement)}"
    )


def _ignored_line(statement: str, source_ref: str) -> str:
    return f"- Skipped possible noise, opt-out, or sensitive content. [{source_ref}]"


def apply_curated_synthesis(
    source: dict[str, str], source_text: str
) -> tuple[list[str], int]:
    source_ref = f"{source['source_type']}:{source['source_id']}"
    if source["source_type"] == "note_entry":
        source_ref = f"note:{source['source_id']}"
    target_slugs = {
        slug
        for statement in _statement_lines(source_text)
        if (slug := _curated_page_for_statement(statement)) is not None
    }
    sections_by_slug = {
        slug: _load_curated_page(slug)
        for slug in _CURATED_PAGE_SPECS.keys()
        if slug in target_slugs
    }
    seen_keys: dict[str, tuple[str, str]] = {}
    for slug, sections in sections_by_slug.items():
        for line in sections["facts"]:
            key = _canonical_fact_key(line)
            if key:
                seen_keys[key] = (slug, line)

    changed_pages: list[str] = []
    promoted = 0
    for statement in _statement_lines(source_text):
        if _NOISE_RE.search(statement):
            sections_by_slug.setdefault("user", _load_curated_page("user"))[
                "ignored"
            ].add(_ignored_line(statement, source_ref))
            continue
        slug = _curated_page_for_statement(statement)
        if slug is None or not _DURABLE_RE.search(statement):
            continue
        key = _canonical_fact_key(statement)
        if not key:
            continue
        existing = seen_keys.get(key)
        line = _fact_line(statement, source_ref)
        if existing is not None:
            existing_slug, existing_line = existing
            merged_line = _merged_fact_line(existing_line, source_ref)
            if line == existing_line or merged_line != existing_line:
                sections_by_slug[existing_slug]["facts"].discard(existing_line)
                sections_by_slug[existing_slug]["facts"].add(merged_line)
                seen_keys[key] = (existing_slug, merged_line)
                if line != existing_line:
                    conflict = (
                        f"- Possible duplicate or changed fact: {statement} "
                        f"source=[{source_ref}] "
                        f"conflicts_with={merged_line}"
                    )
                    sections_by_slug[existing_slug]["conflicts"].add(conflict)
                promoted += int(merged_line != existing_line)
            else:
                conflict = (
                    f"- Possible duplicate or changed fact: {line.removeprefix('- ')} "
                    f"conflicts_with={existing_line}"
                )
                sections_by_slug[existing_slug]["conflicts"].add(conflict)
            continue
        sections_by_slug[slug]["facts"].add(line)
        seen_keys[key] = (slug, line)
        promoted += 1

    for slug, sections in sections_by_slug.items():
        if _write_curated_page(slug, sections):
            changed_pages.append(f"{WIKI_DIR}/{slug}.md")
    return changed_pages, promoted


def refresh_memory_index() -> None:
    root = wiki_root()
    wiki_dir = root / WIKI_DIR
    pages = sorted(p.name for p in wiki_dir.glob("*.md") if p.is_file())
    lines = [
        "# Memory Index",
        "",
        "Dream-maintained flat index of curated and source-compiled `wiki/*.md` memory pages.",
        "",
    ]
    if pages:
        lines.extend(f"- `wiki/{name}`" for name in pages)
    else:
        lines.append("- (no compiled pages yet)")
    (root / INDEX_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")


async def upsert_memory_processed_source(
    db: AsyncSession,
    source: dict[str, str],
    *,
    status: str,
    pages_changed: list[str] | None = None,
    error: str | None = None,
) -> None:
    stmt = select(MemoryProcessedSource).where(
        col(MemoryProcessedSource.source_type) == source["source_type"],
        col(MemoryProcessedSource.source_id) == source["source_id"],
    )
    row = (await db.exec(stmt)).first()
    if row is None:
        row = MemoryProcessedSource(
            source_type=source["source_type"],
            source_id=source["source_id"],
            content_hash=source["content_hash"],
            processed_at=datetime.now(timezone.utc),
            status=status,
        )
        db.add(row)
    row.content_hash = source["content_hash"]
    row.processed_at = datetime.now(timezone.utc)
    row.status = status
    row.pages_changed = json.dumps(pages_changed or []) if pages_changed else None
    row.error = error
    await db.commit()


async def process_memory_sources(
    db: AsyncSession,
    *,
    limit: int | None = None,
    dream_agent_name: str,
    hash_session_source: Callable[[AsyncSession, UUID], Awaitable[str]],
    load_source_text: Callable[[AsyncSession, dict[str, str]], Awaitable[str]],
    max_prompt_chars: int,
) -> dict[str, int]:
    seed_memory()
    pending = await get_pending_memory_sources(
        db,
        dream_agent_name=dream_agent_name,
        hash_session_source=hash_session_source,
    )
    if limit is not None:
        pending = pending[: max(0, limit)]

    processed = 0
    failed = 0
    for source in pending:
        page = f"{WIKI_DIR}/{_memory_page_slug(source['source_type'], source['source_id'])}.md"
        try:
            source_text = await load_source_text(db, source)
            write_memory_file(
                page,
                _memory_page_content(
                    source, source_text, max_prompt_chars=max_prompt_chars
                ),
            )
            curated_pages, promoted = apply_curated_synthesis(source, source_text)
            pages_changed = [page, *curated_pages]
            refresh_memory_index()
            await upsert_memory_processed_source(
                db, source, status="processed", pages_changed=pages_changed
            )
            processed += 1
            logger.info(
                "dream_memory_source_processed type={} id={} page={} curated={} promoted={}",
                source["source_type"],
                source["source_id"],
                page,
                curated_pages,
                promoted,
            )
        except Exception as exc:
            await db.rollback()
            await upsert_memory_processed_source(
                db, source, status="failed", error=str(exc)
            )
            failed += 1
            logger.warning(
                "dream_memory_source_failed type={} id={} error={}",
                source["source_type"],
                source["source_id"],
                exc,
            )

    remaining = max(
        0,
        len(
            await get_pending_memory_sources(
                db,
                dream_agent_name=dream_agent_name,
                hash_session_source=hash_session_source,
            )
        )
        - failed,
    )
    if processed or failed:
        await append_log_async(
            f"dream memory-v2 | processed={processed} failed={failed} remaining={remaining}"
        )
    return {"processed": processed, "failed": failed, "remaining": remaining}


async def append_log_async(body: str) -> None:
    import asyncio

    await asyncio.to_thread(append_log, body)

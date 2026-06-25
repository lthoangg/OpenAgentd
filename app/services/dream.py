"""Dream service — consolidate wiki from unprocessed sessions and notes.

Dream reads unprocessed chat sessions and note files, runs the dream agent
over each one, and writes to the wiki root and knowledge directories.

The dream prompt is bundled in code. Runtime choices (enabled/model/schedule)
come from ``{OPENAGENTD_CONFIG_DIR}/settings.yaml``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import (
    ChatSession,
    DreamLog,
    DreamNotesLog,
    SessionMessage,
)
from app.core.runtime_settings import load_runtime_settings, runtime_settings_path
from app.services.wiki import (
    COMPARISONS_DIR,
    ENTITIES_DIR,
    INDEX_FILE,
    LINT_FILE,
    NOTES_DIR,
    SOURCES_DIR,
    TOPICS_DIR,
    append_log,
    wiki_root,
)
from app.services import dream_memory as _dream_memory
from app.services.dream_memory import (
    parse_note_entries,
    process_memory_sources as _process_memory_sources,
    get_pending_memory_sources as _get_pending_memory_sources,
)

if TYPE_CHECKING:
    import contextvars

    from app.agent.agent_loop import Agent
    from app.agent.sandbox import SandboxConfig

# ── Dream config schema ───────────────────────────────────────────────────────

# Tools always injected into the dream agent.
# ``edit`` and ``rm`` are required by the system prompt — without them, the
# "surgical update" and (rare) "delete on user request" rules cannot be honoured.
_REQUIRED_TOOLS: list[str] = ["read", "write", "edit", "rm", "ls", "wiki_search"]

# Hard caps to keep dream resilient. These exist to bound failure modes — they
# are not knobs users typically need to tune.
DEFAULT_LLM_TIMEOUT_SECONDS = 300  # 5 min — covers most reasonable transcripts
DEFAULT_MAX_PROMPT_CHARS = 60_000  # ~15k tokens — fits inside any modern context
PER_MESSAGE_CAP_CHARS = 4_000
BATCH_SIZE = 1

DREAM_SYSTEM_PROMPT = """\
You are the dream agent. Your job is to maintain a wiki — a structured,
interlinked markdown knowledge base — from unprocessed conversation sessions
and notes.

The wiki is a persistent, compounding artifact: every source you ingest should
make existing pages richer, not just add new isolated pages.

Working directory layout:
- USER.md: durable facts about the user. Keep this file as pure YAML.
- INDEX.md: table-of-contents catalogue listing every knowledge page.
- LOG.md: append-only chronological log. Never edit it.
- LINT.md: most recent lint report.
- topics/{slug}.md: concepts, techniques, and patterns.
- entities/{slug}.md: concrete people, tools, products, and organisations.
- sources/{slug}.md: one summary per ingested source.
- comparisons/{slug}.md: X vs Y pages.
- notes/{date}.md: read-only input; never edit notes.

Each prompt begins with Today, Wiki state, and Source-Slug headers. Use Today
verbatim in updated frontmatter. Prefer editing existing pages listed in Wiki
state over creating duplicates.

For every meaningful source:
1. Create or update sources/{Source-Slug}.md first.
2. Update USER.md only for durable user facts.
3. Create or update topic, entity, and comparison pages with YAML frontmatter:
   description, tags, updated, confidence, sources, and related.
4. Update related existing pages and INDEX.md.

Rules:
- Only promote durable facts worth remembering across sessions.
- Skip noise, small talk, and one-off observations.
- If a source is trivial, do not write source or derivative pages.
- Use edit for surgical updates to existing pages.
- Never write to, edit, or delete anything under notes/.
- Never edit LOG.md.
- Slugs are lowercase-kebab-case.
- Write precise, query-friendly descriptions because they drive wiki_search.
"""

# Cap on bytes of ``INDEX.md`` injected into each per-item prompt as
# de-duplication context.  Keeps prompt token budget predictable even when
# the wiki's TOC grows large.  At 8KB this is ~2k tokens — small relative
# to typical transcript size.
INDEX_CONTEXT_MAX_CHARS = 8_000

# Serialise dream runs so manual /api/dream/run cannot race the scheduler fire
# and crash on the dream_log.session_id UNIQUE constraint.
_run_lock = asyncio.Lock()


class DreamAgentConfig(BaseModel):
    """Dream runtime configuration.

    Contains the runtime fields needed to build and run the built-in Dream
    agent.
    """

    # ── Agent identity (mirrors AgentConfig subset) ──
    name: str = "dream"
    model: str | None = None
    description: str | None = None
    temperature: float | None = None
    thinking_level: str | None = None
    tools: list[str] = Field(default_factory=list)
    system_prompt: str = DREAM_SYSTEM_PROMPT

    # ── Dream-specific ────────────────────────────────
    enabled: bool = False
    schedule: str = "0 2 * * *"
    batch_size: int = BATCH_SIZE
    """Number of sessions/notes to process per run_dream() call.

    Defaults to 1 — each scheduler fire (or manual /dream/run trigger)
    processes exactly one item with a fresh agent instance.  Increase for
    bulk catch-up runs, but keep small enough that the LLM context stays
    focused on one conversation at a time.
    """

    timeout_seconds: int = DEFAULT_LLM_TIMEOUT_SECONDS
    """Per-item LLM timeout. Hard cap so a stuck provider can't wedge dream
    forever (and block scheduler reload / shutdown).

    Must be ``>= 1`` — ``asyncio.wait_for(..., timeout=0)`` raises
    :exc:`TimeoutError` immediately, which would fail every run.
    """

    @model_validator(mode="after")
    def _validate_timeout(self) -> "DreamAgentConfig":
        if self.timeout_seconds < 1:
            raise ValueError(
                f"Dream timeout_seconds must be >= 1 second, got "
                f"{self.timeout_seconds}."
            )
        return self

    @model_validator(mode="after")
    def _inject_required_tools(self) -> "DreamAgentConfig":
        for tool in _REQUIRED_TOOLS:
            if tool not in self.tools:
                self.tools.append(tool)
        return self

    @model_validator(mode="after")
    def _validate_model(self) -> "DreamAgentConfig":
        if self.model and ":" not in self.model:
            raise ValueError(
                f"Dream model '{self.model}' must be 'provider:model' "
                "(e.g. 'googlegenai:gemini-2.0-flash')."
            )
        return self


def load_dream_config() -> DreamAgentConfig:
    settings_cfg = load_runtime_settings().dream
    return DreamAgentConfig(
        model=settings_cfg.model,
        enabled=settings_cfg.enabled,
        schedule=settings_cfg.schedule,
    )


# ── Helpers ───────────────────────────────────────────────────────────────────


# Default sentinel agent_name for dream's own sessions.
DREAM_AGENT_NAME = "dream"


hash_import_source = _dream_memory.hash_import_source


def _hash_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def get_unprocessed_sessions(
    db: AsyncSession,
    *,
    dream_agent_name: str = DREAM_AGENT_NAME,
) -> list[ChatSession]:
    """Return sessions not yet in ``dream_log``, excluding sessions that
    belong to the dream agent itself.

    Uses a SQL anti-join (``WHERE NOT IN``) so the worst case is a single
    indexed scan of ``chat_sessions`` plus a subquery on ``dream_log`` —
    not the previous "load every row then filter in Python" pattern that
    became O(n) memory for large deployments.

    Empty sessions **are** included in the result — :func:`run_dream`
    inspects them via :func:`_split_sessions_by_emptiness` (one batched
    query, not N+1) and writes the "empty" log row inside its own per-item
    transaction.
    """
    processed_subquery = select(DreamLog.session_id)
    stmt = select(ChatSession).where(
        col(ChatSession.id).not_in(processed_subquery),
        col(ChatSession.agent_name) != dream_agent_name,
    )
    return list((await db.exec(stmt)).all())


async def _split_sessions_by_emptiness(
    db: AsyncSession, sessions: list[ChatSession]
) -> tuple[list[ChatSession], list[ChatSession]]:
    """Return ``(real, empty)`` — one batched query, not N+1.

    A session is *empty* when it has no non-system, non-excluded messages.
    Previously this was one ``SELECT ... LIMIT 1`` per session in a Python
    loop; for a backlog of N sessions that's N round-trips before the first
    LLM call.  Single ``GROUP BY`` query collapses it to one.
    """
    if not sessions:
        return [], []

    session_ids = [s.id for s in sessions]
    stmt = (
        select(SessionMessage.session_id)
        .where(col(SessionMessage.session_id).in_(session_ids))
        .where(~col(SessionMessage.exclude_from_context))
        .where(col(SessionMessage.role) != "system")
        .group_by(col(SessionMessage.session_id))
    )
    with_messages = set((await db.exec(stmt)).all())

    real: list[ChatSession] = []
    empty: list[ChatSession] = []
    for s in sessions:
        (real if s.id in with_messages else empty).append(s)
    return real, empty


async def get_unprocessed_notes(db: AsyncSession) -> list[str]:
    """Return note filenames not yet in ``dream_notes_log``.

    SQL-side filter via anti-join — the file list still comes from disk
    (notes are filesystem-backed) but membership in ``dream_notes_log`` is
    excluded with a single ``WHERE filename NOT IN (...)`` predicate.
    """
    root = wiki_root()
    notes_dir = root / NOTES_DIR
    if not notes_dir.is_dir():
        return []

    all_notes = [
        entry.name
        for entry in sorted(notes_dir.iterdir())
        if entry.is_file() and entry.suffix == ".md"
    ]
    if not all_notes:
        return []

    stmt = select(DreamNotesLog.filename).where(
        col(DreamNotesLog.filename).in_(all_notes)
    )
    processed = set((await db.exec(stmt)).all())
    return [n for n in all_notes if n not in processed]


async def hash_session_source(db: AsyncSession, session_id: uuid.UUID) -> str:
    """Hash visible, non-excluded messages for a DB session source."""
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session_id)
        .where(~col(SessionMessage.exclude_from_context))
        .where(col(SessionMessage.role) != "system")
        .order_by(col(SessionMessage.created_at).asc(), col(SessionMessage.id).asc())
    )
    rows = (await db.exec(stmt)).all()
    payload = [
        {
            "id": str(msg.id),
            "role": msg.role,
            "content": msg.content or "",
            "reasoning_content": msg.reasoning_content or "",
            "tool_calls": msg.tool_calls,
            "tool_call_id": msg.tool_call_id,
            "name": msg.name,
            "created_at": msg.created_at.isoformat(),
        }
        for msg in rows
    ]
    return _hash_text(json.dumps(payload, sort_keys=True, separators=(",", ":")))


async def get_pending_memory_sources(
    db: AsyncSession,
    *,
    dream_agent_name: str = DREAM_AGENT_NAME,
) -> list[dict[str, str]]:
    """Return session, note-entry, and import sources pending Dream v2."""
    return await _get_pending_memory_sources(
        db,
        dream_agent_name=dream_agent_name,
        hash_session_source=hash_session_source,
    )


async def _memory_source_text(db: AsyncSession, source: dict[str, str]) -> str:
    source_type = source["source_type"]
    source_id = source["source_id"]
    root = wiki_root()

    if source_type == "session":
        session = await db.get(ChatSession, uuid.UUID(source_id))
        if session is None:
            raise FileNotFoundError(f"Session source not found: {source_id}")
        return await _fetch_session_transcript(db, session)

    if source_type == "note_entry":
        filename, _, _entry = source_id.partition("#")
        note_path = root / NOTES_DIR / filename
        entries = parse_note_entries(filename, note_path.read_text(encoding="utf-8"))
        for entry in entries:
            if entry["source_id"] == source_id:
                return f"# {entry['heading']}\n\n{entry['content']}".strip()
        raise FileNotFoundError(f"Note entry source not found: {source_id}")

    if source_type == "import":
        import_path = root / "imports" / f"{source_id}.md"
        return import_path.read_text(encoding="utf-8")

    raise ValueError(f"Unsupported memory source type: {source_type}")


async def process_memory_sources(
    db: AsyncSession,
    *,
    limit: int | None = None,
) -> dict[str, int]:
    """Run deterministic Dream v2 maintenance for pending memory sources."""
    return await _process_memory_sources(
        db,
        limit=limit,
        dream_agent_name=DREAM_AGENT_NAME,
        hash_session_source=hash_session_source,
        load_source_text=_memory_source_text,
        max_prompt_chars=DEFAULT_MAX_PROMPT_CHARS,
    )


run_memory_maintenance = process_memory_sources


async def mark_session_processed(
    db: AsyncSession,
    session_id: uuid.UUID,
    agent_name: str,
    topics_written: list[str],
) -> None:
    """Insert row into dream_log and commit immediately.

    Per-item commit so a later crash cannot roll back earlier successes
    (or leave wiki files on disk without a corresponding ``dream_log`` row).

    Silently swallows :class:`IntegrityError` when the session is already
    logged — the ``dream_log.session_id`` UNIQUE constraint can be tripped
    by an out-of-process race (e.g. ``manual.dream run --direct`` running
    while the server fires a scheduled run).  ``_run_lock`` only guards
    the in-process case, so we must still tolerate the cross-process one.
    """
    log = DreamLog(
        session_id=session_id,
        processed_at=datetime.now(timezone.utc),
        agent_name=agent_name,
        topics_written=json.dumps(list(dict.fromkeys(topics_written)))
        if topics_written
        else None,
    )
    db.add(log)
    try:
        await db.commit()
    except IntegrityError:
        # Cross-process race only — dedupe and move on.
        await db.rollback()
        logger.info(
            "dream_log_already_marked session_id={} agent={}",
            session_id,
            agent_name,
        )
    except Exception:
        # Disk full, lock timeout, schema drift — re-raise after rolling
        # back so the caller can surface the failure.  Do NOT silence;
        # silent swallowing would re-process the same session forever.
        await db.rollback()
        logger.exception(
            "dream_log_commit_failed session_id={} agent={}",
            session_id,
            agent_name,
        )
        raise


async def mark_note_processed(db: AsyncSession, filename: str) -> None:
    """Insert row into dream_notes_log and commit immediately.

    Silently swallows :class:`IntegrityError` for the same cross-process
    race reason as :func:`mark_session_processed`.  Any other commit error
    is re-raised after rollback so it doesn't get masked.
    """
    log = DreamNotesLog(
        filename=filename,
        processed_at=datetime.now(timezone.utc),
    )
    db.add(log)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        logger.info("dream_notes_log_already_marked filename={}", filename)
    except Exception:
        await db.rollback()
        logger.exception("dream_notes_log_commit_failed filename={}", filename)
        raise


async def _mark_item_processed(
    db: AsyncSession,
    kind: str,
    item: ChatSession | str,
    *,
    topics_written: list[str] | None = None,
) -> None:
    """Dispatch to the appropriate ``mark_*_processed`` for one work item.

    Removes a duplicate block in the infra-only / loader-failure branches
    of :func:`_run_dream_locked`.
    """
    if kind == "session":
        # Explicit type check (not ``assert``) so ``python -O`` doesn't
        # silently turn a programming error into a misleading
        # ``AttributeError`` deep in ``mark_session_processed``.
        if not isinstance(item, ChatSession):
            raise TypeError(
                f"_mark_item_processed kind='session' expects ChatSession, "
                f"got {type(item).__name__}"
            )
        await mark_session_processed(
            db,
            session_id=item.id,
            agent_name=item.agent_name or "unknown",
            topics_written=topics_written or [],
        )
    else:
        if not isinstance(item, str):
            raise TypeError(
                f"_mark_item_processed kind='note' expects str, "
                f"got {type(item).__name__}"
            )
        await mark_note_processed(db, item)


# ── Dream agent loader ────────────────────────────────────────────────────────


def _load_dream_agent(
    cfg: "DreamAgentConfig",
) -> "tuple[Agent, contextvars.Token[SandboxConfig]] | None":
    """Load the dream agent from a parsed :class:`DreamAgentConfig`.

    Returns a tuple of ``(agent, sandbox_token)`` so the caller can restore
    the previous sandbox via :func:`contextvars.Token.reset` once the run
    completes.  Returns ``None`` when no model is configured.

    The caller is responsible for resetting the sandbox — failure to do so
    leaks the wiki workspace into any subsequent activity on the same
    asyncio task.

    Construction order matters: the ``AgentConfig`` is validated FIRST
    (it can raise on bad model strings, missing tools, etc.), so the
    sandbox is only mutated when we know the build will proceed.  This
    keeps the contract simple: ``set_sandbox`` is paired exactly with the
    returned token; no token leaks on early validation failures.
    """
    from app.agent.loader import AgentConfig, _build_agent, _default_tool_registry
    from app.agent.providers.factory import build_provider
    from app.agent.sandbox import SandboxConfig, _sandbox_ctx, set_sandbox

    if not cfg.model:
        logger.debug("dream_agent_skip no model configured")
        return None

    # Project DreamAgentConfig → AgentConfig (the agent builder's contract).
    # role is always "member" for the dream agent — it never leads a team.
    # Build the AgentConfig BEFORE touching the sandbox so a validation
    # failure can't leak a half-set sandbox context.
    try:
        agent_cfg = AgentConfig(
            name=cfg.name,
            role="member",
            description=cfg.description,
            model=cfg.model,
            temperature=cfg.temperature,
            thinking_level=cfg.thinking_level,
            tools=list(cfg.tools),
            system_prompt=cfg.system_prompt,
        )
    except Exception as exc:
        logger.warning("dream_agent_config_build_failed error={}", exc)
        return None

    # Set the sandbox workspace to wiki_root() so the dream agent's filesystem
    # tools (ls, read, write, edit, rm) resolve relative paths against the
    # wiki directory.  Keep the token so the caller can restore.
    token = set_sandbox(SandboxConfig(workspace=str(wiki_root())))

    try:
        agent = _build_agent(
            agent_cfg,
            _default_tool_registry(),
            build_provider,
            source_path=runtime_settings_path(),
        )
        logger.info("dream_agent_loaded model={} tools={}", cfg.model, cfg.tools)
        return agent, token
    except Exception as exc:
        logger.warning("dream_agent_build_failed error={}", exc)
        _sandbox_ctx.reset(token)
        return None


# ── Existing-wiki context (E2: de-duplication prompt prefix) ──────────────────


def _today_block() -> str:
    """Return a single-line "Today: YYYY-MM-DD UTC" prompt prefix.

    The dream LLM otherwise hallucinates dates in ``updated:`` frontmatter
    and lint reports (it has no internal clock).  Stable, parseable, cheap.
    """
    return "Today: " + datetime.now(timezone.utc).strftime("%Y-%m-%d UTC") + "\n\n"


def _build_wiki_context() -> str:
    """Build a prompt prefix listing existing wiki state.

    Injected before each item's transcript/note so the dream agent can
    de-duplicate against existing pages *without* having to remember to
    call ``ls`` and ``read INDEX.md`` first.  Addresses the
    fragmentation-over-time bug where two sessions about the same subject
    spawned fresh topic files.

    Always starts with a ``Today: ...`` line so the LLM does not hallucinate
    the current date in ``updated:`` frontmatter or page bodies.

    Surfaces all four knowledge dirs (``topics/``, ``entities/``,
    ``sources/``, ``comparisons/``) so the agent picks the right page-type
    in line with the Karpathy LLM-Wiki pattern.  Bounded by
    :data:`INDEX_CONTEXT_MAX_CHARS` so a large wiki cannot blow the prompt
    budget — INDEX.md is truncated first, then per-dir slug lists are
    truncated if still over budget.

    Returns the today-block alone on a first-ever run (no existing pages
    to surface yet) — keeps the date prefix consistent across all runs.
    """
    root = wiki_root()
    parts: list[str] = []

    index_path = root / INDEX_FILE
    if index_path.is_file():
        try:
            index_text = index_path.read_text(encoding="utf-8").strip()
        except OSError:
            index_text = ""
        if index_text:
            if len(index_text) > INDEX_CONTEXT_MAX_CHARS:
                index_text = (
                    index_text[:INDEX_CONTEXT_MAX_CHARS]
                    + "\n[... INDEX.md truncated ...]"
                )
            parts.append("Current INDEX.md:\n" + index_text)

    # List slugs for each knowledge dir so the agent can pick edit-over-write
    # for any subject.  Limit each listing to keep the prompt bounded — the
    # ones beyond the cap are dropped entirely (the LLM still has ``ls`` if
    # it wants to inspect further).
    per_dir_cap = 200  # ~one screen per dir
    for label, subdir in (
        ("topic", TOPICS_DIR),
        ("entity", ENTITIES_DIR),
        ("source", SOURCES_DIR),
        ("comparison", COMPARISONS_DIR),
    ):
        d = root / subdir
        if not d.is_dir():
            continue
        slugs = sorted(f.stem for f in d.iterdir() if f.is_file() and f.suffix == ".md")
        if not slugs:
            continue
        listed = slugs[:per_dir_cap]
        more = (
            "" if len(slugs) == len(listed) else f" (+{len(slugs) - len(listed)} more)"
        )
        parts.append(
            f"Existing {label} slugs ({len(slugs)}): " + ", ".join(listed) + more
        )

    if not parts:
        # First-ever run still gets the today block so the LLM doesn't
        # hallucinate dates in the first batch of pages.
        return _today_block() + "---\n\n"

    return (
        _today_block()
        + "Wiki state — prefer ``edit`` on these existing pages over creating "
        "duplicates.  Use ``[[slug]]`` to cross-reference between pages.\n\n"
        + "\n\n".join(parts)
        + "\n\n---\n\n"
    )


# ── Session transcript formatter ──────────────────────────────────────────────


async def _fetch_session_transcript(
    db: AsyncSession,
    session: ChatSession,
    *,
    max_total_chars: int = DEFAULT_MAX_PROMPT_CHARS,
) -> str:
    """Return a readable transcript of the session for the dream agent.

    Bounded by ``max_total_chars``: per-message truncation comes first
    (long single messages get clipped to ``PER_MESSAGE_CAP_CHARS``), then
    if the assembled transcript still exceeds the cap, the **oldest middle**
    messages are dropped — first and last messages are kept verbatim so
    the LLM still sees how the conversation opened and concluded.
    """
    stmt = (
        select(SessionMessage)
        .where(col(SessionMessage.session_id) == session.id)
        .where(~col(SessionMessage.exclude_from_context))
        .order_by(col(SessionMessage.created_at).asc())
    )
    rows = (await db.exec(stmt)).all()

    if not rows:
        return "(empty session)"

    # Header gives the LLM a stable, short source identifier.  ``Source-Slug``
    # is used verbatim as the ``sources/{slug}.md`` filename AND in
    # ``sources:`` frontmatter of every page derived from this session, so
    # multiple ingests of the same conversation update the same source page
    # rather than fragmenting.  We use the LAST 8 hex chars of the session
    # UUID — these come from the random portion of a UUIDv7, giving full
    # entropy.  Using ``hex[:8]`` would collide for sessions created in the
    # same millisecond (the first 48 bits of UUIDv7 encode the timestamp).
    # The full UUID is never exposed to the LLM, preserving the "no raw
    # UUIDs in body content" invariant.
    created_date = (
        session.created_at.strftime("%Y-%m-%d") if session.created_at else "unknown"
    )
    short_id = session.id.hex[-8:]
    header = [
        f"Source-Slug: session-{short_id}",
        f"Agent: {session.agent_name or 'unknown'}",
        f"Date: {created_date}",
        "",
    ]
    header_text = "\n".join(header)

    def _render(msg: SessionMessage) -> str:
        content = msg.content or ""
        if len(content) > PER_MESSAGE_CAP_CHARS:
            content = content[:PER_MESSAGE_CAP_CHARS] + "\n[... truncated ...]"
        return f"### {msg.role.upper()}\n{content}\n"

    rendered = [_render(m) for m in rows]
    budget = max_total_chars - len(header_text)

    # Drop oldest middle messages until we fit. Always keep first + last.
    # ``total_len`` is tracked incrementally so the loop stays O(n) — a
    # naive ``sum(len(r) for r in rendered)`` on every iteration would be
    # O(n²) for very long conversations.
    #
    # ``elision_present`` is the loop invariant: a single marker at
    # index 1 once we've dropped anything.  Inserting it once and then
    # popping subsequent middles around it avoids a "remove-then-add"
    # infinite loop a naive implementation produces when only the
    # first + last + elision remain.
    elision = "### [... middle messages elided to fit context window ...]\n"
    total_len = sum(len(r) for r in rendered)
    elision_present = False
    while total_len > budget:
        # The drop target is whichever non-anchor slot is right after the
        # first message (index 1, or 2 if the elision marker holds slot 1).
        drop_idx = 2 if elision_present else 1
        if drop_idx >= len(rendered) - 1:
            # Only first + (elision) + last remain — no more middles to drop.
            break
        removed = rendered.pop(drop_idx)
        total_len -= len(removed)
        if not elision_present:
            rendered.insert(1, elision)
            total_len += len(elision)
            elision_present = True

    return header_text + "\n".join(rendered)


# ── Topics diff helper ────────────────────────────────────────────────────────


def _topics_snapshot() -> dict[str, int]:
    """Return ``{filename: mtime_ns}`` for every topic file.

    Used to detect both new files **and** modifications to existing files
    — a plain set-difference would only catch creates and silently log
    in-place edits as "no topics written".

    Uses ``st_mtime_ns`` (integer nanoseconds) instead of ``st_mtime``
    (float seconds) so two writes within the same second on filesystems
    with coarse mtime granularity (HFS+, FAT32) still surface as changes.
    """
    topics_dir = wiki_root() / TOPICS_DIR
    if not topics_dir.is_dir():
        return {}
    snap: dict[str, int] = {}
    for f in topics_dir.iterdir():
        if f.is_file() and f.suffix == ".md":
            try:
                snap[f.name] = f.stat().st_mtime_ns
            except OSError:
                continue
    return snap


def _diff_topics(before: dict[str, int], after: dict[str, int]) -> list[str]:
    """Return slugs of topic files that were created, modified, OR deleted.

    Tracking deletes matters for audit fidelity: when the dream LLM uses
    ``rm`` to drop a stale topic, the action should show up in
    ``dream_log.topics_written`` instead of being recorded as "(none)".
    Slugs are deduped via a set (defensive — a single mtime snapshot won't
    surface the same slug twice, but cheap insurance against caller bugs).
    """
    changed: set[str] = set()
    for name, mtime in after.items():
        if name not in before or mtime > before[name]:
            changed.add(Path(name).stem)
    for name in before.keys() - after.keys():
        changed.add(Path(name).stem)
    return sorted(changed)


# ── LLM synthesis ─────────────────────────────────────────────────────────────


class _SynthesisFailed(RuntimeError):
    """Raised when the LLM call fails — distinguishes failure from
    'ran successfully but produced no topics' so the caller can skip
    ``mark_*_processed`` and retry on the next run.
    """


async def _synthesise_session(
    agent: "Agent",
    db: AsyncSession,
    session: ChatSession,
    *,
    timeout_seconds: int,
    wiki_context: str = "",
) -> list[str]:
    """Run the dream agent over one session.

    ``wiki_context`` is a (possibly empty) prefix listing existing topics
    so the agent can prefer ``edit`` over ``write`` and avoid creating
    duplicates.  Built once per :func:`run_dream` invocation and shared
    across all items in the batch.

    Returns the list of changed topic slugs on success.  Raises
    :class:`_SynthesisFailed` when the LLM call errors or times out —
    the caller uses this to skip ``mark_session_processed`` so the
    session is retried on the next dream run.
    """
    from app.agent.schemas.agent import RunConfig
    from app.agent.schemas.chat import HumanMessage

    transcript = await _fetch_session_transcript(db, session)
    if transcript == "(empty session)":
        logger.debug("dream_session_empty session_id={}", session.id)
        return []

    prompt = (
        wiki_context
        + "Process the following conversation session and update the wiki accordingly.\n\n"
        + transcript
    )

    before = _topics_snapshot()
    try:
        # Pass an empty RunConfig — NOT the target session's id.  Dream
        # runs are not part of the user's conversation history and nothing
        # in dream relies on RunContext.session_id, so leaving it None is
        # correct.  Using ``str(uuid.uuid4())`` (UUIDv4) here would also
        # produce a garbage ``session_created_at`` because RunConfig's
        # validator decodes a UUIDv7 timestamp from the top 48 bits.
        await asyncio.wait_for(
            agent.run(
                [HumanMessage(content=prompt)],
                config=RunConfig(),
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        logger.warning(
            "dream_session_llm_timeout session_id={} timeout_seconds={}",
            session.id,
            timeout_seconds,
        )
        raise _SynthesisFailed("LLM timeout") from exc
    except Exception as exc:
        logger.warning(
            "dream_session_llm_failed session_id={} error={}", session.id, exc
        )
        raise _SynthesisFailed(str(exc)) from exc

    after = _topics_snapshot()
    return _diff_topics(before, after)


async def _synthesise_note(
    agent: "Agent",
    filename: str,
    *,
    timeout_seconds: int,
    wiki_context: str = "",
) -> list[str]:
    """Run the dream agent over one note file.

    See :func:`_synthesise_session` for ``wiki_context`` semantics.

    Returns changed topic slugs on success; raises :class:`_SynthesisFailed`
    when the LLM call errors or times out.
    """
    from app.agent.schemas.agent import RunConfig
    from app.agent.schemas.chat import HumanMessage

    note_path = wiki_root() / NOTES_DIR / filename
    try:
        content = note_path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("dream_note_read_failed filename={} error={}", filename, exc)
        raise _SynthesisFailed(f"note read failed: {exc}") from exc

    if not content.strip():
        return []

    # Stable per-source slug — see _fetch_session_transcript for rationale.
    # Notes already have a filename, so we use its stem (kebab-cased).
    note_slug = "note-" + Path(filename).stem.lower().replace("_", "-")
    prompt = (
        wiki_context
        + "Process the following note and update the wiki accordingly.\n\n"
        + f"Source-Slug: {note_slug}\n"
        + f"Note file: {filename}\n\n"
        + content
    )

    before = _topics_snapshot()
    try:
        await asyncio.wait_for(
            agent.run(
                [HumanMessage(content=prompt)],
                config=RunConfig(),
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        logger.warning(
            "dream_note_llm_timeout filename={} timeout_seconds={}",
            filename,
            timeout_seconds,
        )
        raise _SynthesisFailed("LLM timeout") from exc
    except Exception as exc:
        logger.warning("dream_note_llm_failed filename={} error={}", filename, exc)
        raise _SynthesisFailed(str(exc)) from exc

    after = _topics_snapshot()
    return _diff_topics(before, after)


# ── Main entry point ──────────────────────────────────────────────────────────


# ── Lint operation ────────────────────────────────────────────────────────────


_LINT_PROMPT = """\
You are running the dream agent in LINT mode.  Health-check the wiki.

Your working directory is the wiki root.  Use ``ls`` and ``read`` to inspect:
- ``USER.md``, ``INDEX.md``, ``LOG.md`` (root files)
- ``topics/``, ``entities/``, ``sources/``, ``comparisons/`` (knowledge pages)

**YOU MUST WRITE A REPORT.**  The final action of this turn is a single
``write`` call to ``LINT.md`` — even when the wiki is healthy and there
are no issues.  Skipping the write is a failure mode.

Check for issues across these categories:

1. **Contradictions** — claims that conflict between pages.
2. **Orphan pages** — knowledge pages not referenced by any ``[[wikilink]]``
   from another page.
3. **Missing concepts** — slugs referenced via ``[[slug]]`` from other pages
   but with no corresponding file under any knowledge dir.
4. **Stale claims** — pages whose ``updated:`` frontmatter is more than 6
   months old, OR pages whose content sounds outdated.
5. **Low-confidence pages** — pages with ``confidence: low`` frontmatter
   that could be promoted or removed.
6. **Index drift** — entries in ``INDEX.md`` that no longer have a backing
   file, OR knowledge pages missing from the INDEX.

Overwrite ``LINT.md`` with this exact format::

    ---
    generated: YYYY-MM-DD UTC
    issues: N
    ---

    # Wiki Lint Report

    ## Contradictions (M)
    - [page A] vs [page B]: ...

    ## Orphan pages (M)
    - [[slug]]: ...

    ## Missing concepts (M)
    - [[slug]] referenced from [[other-page]] — no file exists

    ## Stale claims (M)
    - [[slug]]: last updated YYYY-MM-DD

    ## Low-confidence pages (M)
    - [[slug]]

    ## Index drift (M)
    - INDEX.md lists [[slug]] but no file exists
    - [[slug]] exists but is missing from INDEX.md

When a category has zero items, still include the header with "(0)" and a
single line "- (none)" so the report structure is uniform across runs.

When the wiki is fully healthy, the report still gets written — every
category shows "(0)" / "- (none)" and ``issues: 0`` in the frontmatter.

Do NOT modify any file other than ``LINT.md``.  Lint is read-only over
the rest of the wiki.
"""


async def run_dream_lint(db: AsyncSession) -> dict:  # noqa: ARG001 — db kept for parity
    """Run the dream agent in lint mode, writing findings to ``wiki/LINT.md``.

    Returns ``{lint_completed_at, lint_path}`` on success, or
    ``{skipped: <reason>}`` when dream has no model configured. Like
    :func:`run_dream`, this is serialised by ``_run_lock`` so
    a lint pass can't race a synthesis fire.

    Lint is intentionally distinct from synthesis: it has its own prompt,
    runs against the *current* wiki state, and produces a single
    overwriteable report file.  It does NOT touch ``dream_log``.

    The ``db`` parameter is accepted for API symmetry with :func:`run_dream`
    even though the lint agent does not query the database — keeping the
    signatures aligned makes the FastAPI route and CLI plumbing uniform.
    """
    async with _run_lock:
        return await _run_dream_lint_locked()


async def _run_dream_lint_locked() -> dict:
    """Inner lint implementation — assumes ``_run_lock`` is held."""
    from app.agent.sandbox import _sandbox_ctx
    from app.agent.schemas.agent import RunConfig
    from app.agent.schemas.chat import HumanMessage

    try:
        dream_cfg = await asyncio.to_thread(load_dream_config)
    except ValueError as exc:
        logger.warning("dream_lint_config_parse_failed error={}", exc)
        dream_cfg = None

    if dream_cfg is None or not dream_cfg.model:
        logger.info("dream_lint_skip reason=no_model_configured")
        return {"skipped": "no_model_configured"}

    loaded = _load_dream_agent(dream_cfg)
    if loaded is None:
        logger.info("dream_lint_skip reason=agent_load_failed")
        return {"skipped": "agent_load_failed"}

    agent, sandbox_token = loaded
    started = datetime.now(timezone.utc)
    logger.info("dream_lint_start model={}", dream_cfg.model)

    try:
        try:
            await asyncio.wait_for(
                agent.run(
                    [HumanMessage(content=_today_block() + _LINT_PROMPT)],
                    config=RunConfig(),
                ),
                timeout=dream_cfg.timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "dream_lint_llm_timeout timeout_seconds={}",
                dream_cfg.timeout_seconds,
            )
            return {"skipped": "llm_timeout"}
        except Exception as exc:
            logger.warning("dream_lint_llm_failed error={}", exc)
            return {"skipped": f"llm_error: {exc}"}
    finally:
        _sandbox_ctx.reset(sandbox_token)

    duration = (datetime.now(timezone.utc) - started).total_seconds()
    lint_path = wiki_root() / LINT_FILE
    lint_exists = lint_path.is_file()
    logger.info(
        "dream_lint_complete duration_s={:.1f} lint_md_written={}",
        duration,
        lint_exists,
    )

    try:
        await asyncio.to_thread(
            append_log,
            f"lint | duration_s={duration:.1f} "
            f"lint_md_{'written' if lint_exists else 'not_written'}",
        )
    except Exception:
        logger.exception("dream_lint_log_append_failed")

    return {
        "lint_completed_at": datetime.now(timezone.utc).isoformat(),
        "lint_path": LINT_FILE,
        "duration_seconds": duration,
        "lint_md_written": lint_exists,
    }


async def run_dream(db: AsyncSession, *, drain: bool = False) -> dict:
    """Process unprocessed items (interleaved sessions and notes) under a
    global lock so concurrent invocations cannot race on the
    ``dream_log.session_id`` UNIQUE constraint.

    ``drain``:
      - ``False`` (scheduler default) — process one item. Keeps scheduled fires
        bounded.
      - ``True`` (manual API / CLI default) — process every pending item.
        Matches user intent for "Run now": drain the queue.  The previous
        behaviour of also honouring ``batch_size`` here meant manual runs
        only processed 1 item per click on the default config — a footgun.

    Each item gets its own fresh agent instance so no conversation history
    bleeds between items.  Sessions and notes are **interleaved** (one of
    each per round) so a backlog of sessions cannot starve notes.

    Returns::

        {
            "sessions_processed": N,
            "notes_processed": M,
            "remaining": R,
            "failed": F,
        }

    ``failed`` is the count of items whose synthesis raised on this run.
    Failed items stay unprocessed and the scheduler retries them on the
    next fire.  No persistent failure tracking — operators inspect
    ``LOG.md`` and surface persistent failures themselves.
    """
    async with _run_lock:
        return await _run_dream_locked(db, drain=drain)


async def _run_dream_locked(db: AsyncSession, *, drain: bool) -> dict:
    """Inner implementation — assumes ``_run_lock`` is held."""
    dream_cfg: DreamAgentConfig | None = None
    skip_reason: str | None = None
    try:
        dream_cfg = await asyncio.to_thread(load_dream_config)
    except ValueError as exc:
        logger.warning("dream_run_config_parse_failed error={}", exc)
        skip_reason = "config_parse_failed"

    if dream_cfg is not None and not dream_cfg.model:
        skip_reason = "no_model_configured"

    batch_size = max(1, dream_cfg.batch_size) if dream_cfg else 1
    timeout_seconds = (
        dream_cfg.timeout_seconds if dream_cfg else DEFAULT_LLM_TIMEOUT_SECONDS
    )

    dream_agent_name = dream_cfg.name if dream_cfg else DREAM_AGENT_NAME
    unprocessed_sessions = await get_unprocessed_sessions(
        db, dream_agent_name=dream_agent_name
    )
    unprocessed_notes = await get_unprocessed_notes(db)

    # Single batched query splits real/empty — replaces the previous N+1
    # ``_session_has_messages`` loop.
    real_sessions, empty_sessions = await _split_sessions_by_emptiness(
        db, unprocessed_sessions
    )

    # Mark empties (no LLM call needed).  Cap drained per run to avoid
    # commit-storms when a long-lived deployment accumulates thousands of
    # test/abandoned empty sessions.  When ``drain=True``, we still cap at
    # the same generous limit — a single manual click should never need
    # to commit > 100k rows.
    empty_session_drain_cap = max(100, batch_size * 100)
    empty_count = 0
    empty_mark_failures = 0
    leftover_empties = 0
    for session in empty_sessions:
        if empty_count >= empty_session_drain_cap:
            leftover_empties += 1
            continue
        try:
            await _mark_item_processed(db, "session", session)
            empty_count += 1
        except Exception:
            # A transient commit failure (disk full, lock timeout) must
            # not abort the whole run — log it, advance, and let the next
            # run retry.  ``mark_session_processed`` already logged the
            # exception with full traceback via ``logger.exception``.
            empty_mark_failures += 1
            logger.warning(
                "dream_empty_session_mark_failed session_id={} retry_next_run=true",
                session.id,
            )
    if empty_count or empty_mark_failures or leftover_empties:
        logger.info(
            "dream_skipped_empty_sessions count={} failures={} leftover={} drain_cap={}",
            empty_count,
            empty_mark_failures,
            leftover_empties,
            empty_session_drain_cap,
        )

    total_remaining = len(real_sessions) + len(unprocessed_notes)
    if total_remaining == 0:
        logger.info("dream_run_nothing_to_process")
        return {
            "sessions_processed": 0,
            "notes_processed": 0,
            "remaining": 0,
            "failed": 0,
        }

    if skip_reason is not None:
        result = {
            "sessions_processed": 0,
            "notes_processed": 0,
            "remaining": total_remaining,
            "failed": 0,
            "skipped": skip_reason,
        }
        logger.info(
            "dream_run_skip reason={} remaining={}", skip_reason, total_remaining
        )
        return result

    if dream_cfg is None:  # pragma: no cover - guarded by skip_reason above
        raise RuntimeError("dream config missing without skip reason")

    # ``drain=True`` (manual triggers) ignores ``batch_size`` and processes
    # everything pending in one go.  Scheduled fires keep the cap so a 2am
    # cron tick can't monopolise the LLM provider for an hour.
    cap = total_remaining if drain else batch_size

    logger.info(
        "dream_run_start sessions={} notes={} cap={} drain={} timeout_s={}",
        len(real_sessions),
        len(unprocessed_notes),
        cap,
        drain,
        timeout_seconds,
    )

    sessions_processed = 0
    notes_processed = 0
    failed = 0

    # Interleave: one session, one note, one session, ... up to cap.
    work: list[tuple[str, ChatSession | str]] = []
    s_iter = iter(real_sessions)
    n_iter = iter(unprocessed_notes)
    while len(work) < cap:
        added = False
        try:
            work.append(("session", next(s_iter)))
            added = True
        except StopIteration:
            pass
        if len(work) >= cap:
            break
        try:
            work.append(("note", next(n_iter)))
            added = True
        except StopIteration:
            pass
        if not added:
            break

    # Wiki context is rebuilt PER ITEM (inside the loop below) so item N+1
    # sees any topics item N just created.  Without this refresh, a drain
    # of 5 sessions on the same subject would each generate a fresh topic
    # file because each item saw the same baseline view from before the
    # batch started.  Cost is negligible — a couple of stat()s + one
    # ``INDEX.md`` read per item.

    # Sandbox restoration is handled per-item via ``_sandbox_ctx.reset(token)``
    # in the inner ``finally`` block below — each ``_load_dream_agent`` call
    # set the wiki workspace and returned a token, and resetting it pops the
    # wiki sandbox back off the contextvar stack.  No outer scope needed:
    # if any item is skipped (e.g. ``_load_dream_agent`` returns ``None``), no
    # token was set and no reset is needed for that item.
    from app.agent.sandbox import _sandbox_ctx

    for kind, item in work:
        item_label = (
            f"session_id={item.id}"
            if isinstance(item, ChatSession)
            else f"filename={item}"
        )
        item_start = datetime.now(timezone.utc)
        logger.info("dream_item_start kind={} {}", kind, item_label)

        loaded = _load_dream_agent(dream_cfg)
        if loaded is None:
            failed += 1
            logger.warning(
                "dream_agent_load_failed kind={} {} retry_next_run=true",
                kind,
                item_label,
            )
            continue

        agent, sandbox_token = loaded
        # Refresh per item so item N+1 sees item N's writes.  Built before
        # the synthesis call so the prompt embeds the post-previous-item
        # state of the wiki.
        wiki_context = await asyncio.to_thread(_build_wiki_context)
        try:
            if kind == "session":
                if not isinstance(item, ChatSession):
                    raise TypeError(  # pragma: no cover - defensive
                        f"work-tuple type drift: kind=session item={type(item).__name__}"
                    )
                try:
                    topics_written = await _synthesise_session(
                        agent,
                        db,
                        item,
                        timeout_seconds=timeout_seconds,
                        wiki_context=wiki_context,
                    )
                except _SynthesisFailed as exc:
                    failed += 1
                    logger.warning(
                        "dream_session_failed session_id={} error={} retry_next_run=true",
                        item.id,
                        exc,
                    )
                    continue
                try:
                    await _mark_item_processed(
                        db, kind, item, topics_written=topics_written
                    )
                except Exception:
                    # Synthesis succeeded but commit failed — leave the
                    # session unprocessed so the next run retries.  The
                    # wiki side-effect is already persisted.
                    failed += 1
                    logger.warning(
                        "dream_session_mark_failed session_id={} retry_next_run=true",
                        item.id,
                    )
                    continue
                sessions_processed += 1
                duration = (datetime.now(timezone.utc) - item_start).total_seconds()
                logger.info(
                    "dream_session_processed session_id={} agent={} topics={} duration_s={:.1f}",
                    item.id,
                    item.agent_name,
                    topics_written,
                    duration,
                )
            else:
                if not isinstance(item, str):
                    raise TypeError(  # pragma: no cover - defensive
                        f"work-tuple type drift: kind=note item={type(item).__name__}"
                    )
                try:
                    topics_written = await _synthesise_note(
                        agent,
                        item,
                        timeout_seconds=timeout_seconds,
                        wiki_context=wiki_context,
                    )
                except _SynthesisFailed as exc:
                    failed += 1
                    logger.warning(
                        "dream_note_failed filename={} error={} retry_next_run=true",
                        item,
                        exc,
                    )
                    continue
                try:
                    await _mark_item_processed(db, kind, item)
                except Exception:
                    failed += 1
                    logger.warning(
                        "dream_note_mark_failed filename={} retry_next_run=true",
                        item,
                    )
                    continue
                notes_processed += 1
                duration = (datetime.now(timezone.utc) - item_start).total_seconds()
                logger.info(
                    "dream_note_processed filename={} topics={} duration_s={:.1f}",
                    item,
                    topics_written,
                    duration,
                )
        finally:
            # Always release the sandbox token so the wiki workspace
            # doesn't leak into the caller's context.
            _sandbox_ctx.reset(sandbox_token)

    remaining = total_remaining - sessions_processed - notes_processed
    result = {
        "sessions_processed": sessions_processed,
        "notes_processed": notes_processed,
        "remaining": remaining,
        "failed": failed,
    }
    logger.info("dream_run_complete result={}", result)

    # Append a human-readable LOG.md entry so users have a chronological
    # record of dream activity alongside the wiki itself (Karpathy LLM-Wiki
    # pattern).  Skip on completely empty runs (drain=False with nothing to
    # do) so the log doesn't fill up with noise from idle cron ticks.
    if sessions_processed or notes_processed or failed or empty_count:
        summary_first_line = (
            f"dream | sessions={sessions_processed} notes={notes_processed} "
            f"failed={failed} drain={drain}"
        )
        details: list[str] = []
        if empty_count:
            details.append(f"- empty sessions drained: {empty_count}")
        if remaining:
            details.append(f"- remaining pending: {remaining}")
        body = summary_first_line + ("\n" + "\n".join(details) if details else "")
        try:
            await asyncio.to_thread(append_log, body)
        except Exception:
            # LOG.md append failure is non-fatal — the synthesis side-effects
            # already landed in dream_log and the wiki.  Log and move on.
            logger.exception("dream_log_append_failed")

    return result

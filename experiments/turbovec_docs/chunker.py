"""Chunk markdown files under documents/ into searchable sections.

Splits each .md file on top-level (## ) headings. Each chunk carries enough
metadata to point back to the source: file path, heading, and line range.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Chunk:
    id: int
    path: str          # relative path, e.g. "docs/architecture.md"
    heading: str        # nearest heading above the chunk, or "" for preamble
    start_line: int      # 1-indexed
    end_line: int
    text: str            # heading + body, used for embedding


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def chunk_markdown_file(path: Path, rel_to: Path) -> list[Chunk]:
    """Split one markdown file into heading-delimited chunks."""
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    rel_path = str(path.relative_to(rel_to))

    sections: list[tuple[str, int, list[str]]] = []  # (heading, start_line, body_lines)
    current_heading = ""
    current_start = 1
    current_body: list[str] = []

    for i, line in enumerate(lines, start=1):
        m = _HEADING_RE.match(line)
        if m:
            if current_body and any(l.strip() for l in current_body):
                sections.append((current_heading, current_start, current_body))
            current_heading = m.group(2).strip()
            current_start = i
            current_body = [line]
        else:
            current_body.append(line)

    if current_body and any(l.strip() for l in current_body):
        sections.append((current_heading, current_start, current_body))

    chunks: list[Chunk] = []
    for heading, start_line, body in sections:
        text = "\n".join(body).strip()
        if not text:
            continue
        end_line = start_line + len(body) - 1
        chunks.append(
            Chunk(
                id=-1,  # assigned by caller
                path=rel_path,
                heading=heading,
                start_line=start_line,
                end_line=end_line,
                text=text,
            )
        )
    return chunks


def chunk_documents(root: Path) -> list[Chunk]:
    """Chunk every .md file under root, assigning sequential ids."""
    chunks: list[Chunk] = []
    next_id = 0
    for path in sorted(root.rglob("*.md")):
        for chunk in chunk_markdown_file(path, rel_to=root):
            chunk.id = next_id
            next_id += 1
            chunks.append(chunk)
    return chunks


if __name__ == "__main__":
    import sys

    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("documents")
    chunks = chunk_documents(root)
    print(f"{len(chunks)} chunks from {root}")
    for c in chunks[:5]:
        print(f"  [{c.id}] {c.path}:{c.start_line}-{c.end_line} '{c.heading}' ({len(c.text)} chars)")

"""wiki_search tool — search wiki topics.

Supports keyword search with BM25 scoring.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from app.agent.hooks.wiki_injection import _score_topics
from app.agent.tools.registry import Tool
from app.services.wiki import list_tree, wiki_root


async def _wiki_search(
    query: Annotated[
        str, Field(description="Search query — natural language or keywords.")
    ],
    methods: Annotated[
        list[Literal["text"]],
        Field(description='Search methods. Only "text" keyword search is available.'),
    ] = ["text"],
    top_k: Annotated[
        int, Field(description="Maximum number of topics to return (default 5).")
    ] = 5,
) -> str:
    """Search wiki topics by keyword or meaning.

    Use this to find relevant knowledge before starting a task,
    or when you need to look up something specific.
    Returns matching topic files with their content.
    """
    # text / BM25 search
    root = wiki_root()
    if not root.exists():
        return "No wiki directory found."

    try:
        tree = list_tree()
    except Exception as exc:
        return f"Failed to list wiki topics: {exc}"

    if not tree.topics:
        return "No topic files in wiki yet."

    scored = _score_topics(query, tree.topics)
    matches = [(info, score) for info, score in scored if score > 0.0][:top_k]

    if not matches:
        return f"No wiki topics matched '{query}'."

    parts = [f"Wiki search results for: '{query}'\n"]
    for info, score in matches:
        path = root / info.path
        try:
            raw = path.read_bytes()
            content = raw[:4096].decode("utf-8", errors="ignore")
            if len(raw) > 4096:
                content += "\n\n[truncated at 4096 bytes]"
        except (OSError, UnicodeDecodeError) as exc:
            content = f"(read error: {exc})"
        parts.append(f"### wiki/{info.path}  (score: {score:.1f})\n{content.rstrip()}")

    return "\n\n".join(parts)


wiki_search = Tool(
    _wiki_search,
    name="wiki_search",
    description=(
        "Search the wiki by keyword — a knowledge base of topics distilled from past conversations. "
        "Use this to recall what was previously discussed or decided on any subject. "
        "Returns full content of matching topic files."
    ),
)

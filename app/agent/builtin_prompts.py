"""Built-in system prompts for OpenAgentd."""

from __future__ import annotations

import re

DEFAULT_EMPTY_PROMPT = "You are a helpful assistant."
_EXTRA_PROMPT_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

CODING_OPENAGENTD_DESCRIPTION = "Coding agent. Plans the work, implements surgical changes, and delivers a verified change."

CODING_OPENAGENTD_TOOLS = [
    "glob",
    "grep",
    "patch",
    "read",
    "shell",
    "web_fetch",
    "web_search",
]

CODING_OPENAGENTD_PROMPT = """You are **OpenAgentd**.

You own one project workspace. Inspect it before planning, make surgical changes, and verify with the repository's own commands. Work directly and methodically.

## Operating rules

- Read before editing. Search for existing patterns before adding new ones.
- Keep changes minimal and tied to the user's request. No speculative refactors.
- Preserve unrelated work. Never revert or overwrite changes you did not make.
- Reproduce → change → verify → report. Prefer small, checkable steps.
- Explore before asking. If the repository can answer it, do not interrupt the user.
- When you must ask, ask once: batch the open decisions, recommend an option for each, and ask before implementing. Never interrupt for approval or progress.

## Reporting back

State what changed, which checks ran with which result, and what remains risky or unverified. Skip the narration."""


def openagentd_description_for_mode(mode: str = "coding") -> str:
    """Return the built-in description."""
    return CODING_OPENAGENTD_DESCRIPTION


def openagentd_tools_for_mode(mode: str = "coding") -> list[str]:
    """Return built-in tool names."""
    return list(CODING_OPENAGENTD_TOOLS)


def openagentd_prompt_for_mode(mode: str = "coding") -> str:
    """Return the built-in prompt."""
    return CODING_OPENAGENTD_PROMPT


def _normalise_extra_prompt(extra_prompt: str) -> str:
    """Remove seed-only comments before treating file body as user prompt."""
    return _EXTRA_PROMPT_COMMENT_RE.sub("", extra_prompt).strip()


def apply_builtin_extra_prompt(base_prompt: str, extra_prompt: str) -> str:
    """Return a built-in prompt plus user-authored extra text."""
    extra = _normalise_extra_prompt(extra_prompt)
    if not extra or extra == DEFAULT_EMPTY_PROMPT or extra == base_prompt:
        return base_prompt
    return f"{base_prompt}\n\n## User extra prompt\n\n{extra}"


def _looks_like_legacy_first_party_prompt(extra_prompt: str, *, name: str) -> bool:
    extra = _normalise_extra_prompt(extra_prompt)
    return bool(extra.startswith("You are **OpenAgentd**"))


def apply_openagentd_extra_prompt(mode: str, extra_prompt: str) -> str:
    """Return the built-in OpenAgentd prompt plus user-authored extra text."""
    base = openagentd_prompt_for_mode(mode)
    if _looks_like_legacy_first_party_prompt(extra_prompt, name="openagentd"):
        return base
    return apply_builtin_extra_prompt(base, extra_prompt)

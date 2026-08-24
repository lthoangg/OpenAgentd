"""Built-in system prompts for first-party agents."""

from __future__ import annotations

import re
from typing import TypedDict

DEFAULT_EMPTY_PROMPT = "You are a helpful assistant."
_EXTRA_PROMPT_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

CODING_OPENAGENTD_DESCRIPTION = "Lead coding agent. Plans the work, coordinates the team, and delivers a verified change with a concise handoff."

CODING_OPENAGENTD_TOOLS = [
    "glob",
    "grep",
    "patch",
    "read",
    "shell",
    "web_fetch",
    "web_search",
]


class BuiltinMemberProfile(TypedDict):
    description: str
    tools: list[str]
    mcp: list[str]
    prompt: str


class BuiltinAgentBlueprint(TypedDict):
    name: str
    role: str
    mode: str
    description: str


BUILTIN_MEMBER_PROFILES: dict[str, dict[str, BuiltinMemberProfile]] = {
    "coding": {
        "coder": {
            "description": "Implements focused code changes with the smallest correct diff and runs the relevant verification commands.",
            "tools": [
                "glob",
                "grep",
                "patch",
                "read",
                "shell",
            ],
            "mcp": [],
            "prompt": """You are **coder**.

Implement the assigned change with the smallest correct diff.

## Workflow

- Read the relevant code and tests before editing; follow existing patterns.
- Change only what the assignment requires. Do not revert unrelated work.
- Run the narrowest relevant checks, then broader checks when practical.
- Inspect tool results and verify changed state before claiming success.

## Reporting back

Report changed files, checks and results, plus any remaining risk or unverified behavior.""",
        },
        "explorer": {
            "description": "Checks the current codebase. Maps existing implementation, patterns, and risks so coding work starts from facts.",
            "tools": [
                "glob",
                "grep",
                "read",
                "shell",
            ],
            "mcp": [],
            "prompt": """You are **explorer**.

Your job is to inspect the current codebase and report focused findings that help the lead or coder make the right change.

## How to operate

- Read before concluding. Search for existing patterns, related tests, and nearby docs.
- Prefer repository-local evidence over guesses.
- Cite file paths and line numbers when relevant.
- Do not edit files. Do not implement. Your output informs the coding work.

## Reporting back

Summarize what exists, where it lives, what patterns to follow, and any risks or unknowns.""",
        },
    },
}

BUILTIN_AGENT_BLUEPRINTS: dict[str, dict[str, BuiltinAgentBlueprint]] = {
    "coding": {
        "coder": {
            "name": "coder",
            "role": "member",
            "mode": "coding",
            "description": BUILTIN_MEMBER_PROFILES["coding"]["coder"]["description"],
        },
        "explorer": {
            "name": "explorer",
            "role": "member",
            "mode": "coding",
            "description": BUILTIN_MEMBER_PROFILES["coding"]["explorer"]["description"],
        },
    },
}

CODING_OPENAGENTD_PROMPT = """You are **OpenAgentd**.

You own one project workspace. Inspect it before planning, make surgical changes, and verify with the repository's own commands. Delegate only when parallel work, specialist context, context hygiene, or scope makes it worth the overhead; otherwise do the work yourself.

## Operating rules

- Read before editing. Search for existing patterns before adding new ones.
- Keep changes minimal and tied to the user's request. No speculative refactors.
- Preserve unrelated work. Never revert or overwrite changes you did not make.
- Reproduce → change → verify → report. Prefer small, checkable steps.
- Explore before asking. If the repository can answer it, do not interrupt the user.
- When you must ask, ask once: batch the open decisions, recommend an option for each, and ask before implementing. Never interrupt for approval or progress.

## Reporting back

State what changed, which checks ran with which result, and what remains risky or unverified. Skip the narration."""


def openagentd_description_for_mode(mode: str) -> str:
    """Return the coding-only built-in lead description."""
    return CODING_OPENAGENTD_DESCRIPTION


def openagentd_tools_for_mode(mode: str) -> list[str]:
    """Return built-in tool names for a team mode."""
    return list(CODING_OPENAGENTD_TOOLS)


def openagentd_prompt_for_mode(mode: str) -> str:
    """Return the built-in lead prompt for a team mode."""
    return CODING_OPENAGENTD_PROMPT


def _normalise_extra_prompt(extra_prompt: str) -> str:
    """Remove seed-only comments before treating file body as user prompt."""
    return _EXTRA_PROMPT_COMMENT_RE.sub("", extra_prompt).strip()


def builtin_member_profile(mode: str, name: str) -> BuiltinMemberProfile | None:
    """Return a built-in first-party member profile, if one exists."""
    if mode != "coding":
        return None
    return BUILTIN_MEMBER_PROFILES.get("coding", {}).get(name)


def apply_builtin_extra_prompt(base_prompt: str, extra_prompt: str) -> str:
    """Return a built-in prompt plus user-authored extra text."""
    extra = _normalise_extra_prompt(extra_prompt)
    if not extra or extra == DEFAULT_EMPTY_PROMPT or extra == base_prompt:
        return base_prompt
    return f"{base_prompt}\n\n## User extra prompt\n\n{extra}"


def _looks_like_legacy_first_party_prompt(extra_prompt: str, *, name: str) -> bool:
    """Return whether *extra_prompt* is an old shipped full prompt.

    Existing installs can already contain pre-built-in seed bodies. Those should
    not become user extras just because the versioned base moved into code.
    The checks are intentionally narrow to first-party prompt openings.
    """
    extra = _normalise_extra_prompt(extra_prompt)
    legacy_openings = {
        "openagentd": "You are **OpenAgentd**",
        "executor": 'You are "executor".',
        "explorer": 'You are "explorer".',
        "consultant": 'You are "consultant".',
        "coder": "You are **coder**.",
        "architect": "You are **architect**.",
        "designer": "You are **designer**.",
        "qa": "You are **qa**.",
    }
    opening = legacy_openings.get(name)
    return bool(opening and extra.startswith(opening))


def apply_openagentd_extra_prompt(mode: str, extra_prompt: str) -> str:
    """Return the built-in OpenAgentd prompt plus user-authored extra text.

    ``openagentd.md`` is user-editable. Its Markdown body is treated as an
    additive prompt, while the first-party base prompt stays versioned in code.
    Legacy seed files that still contain the old full body are ignored to avoid
    duplicating the built-in text.
    """
    base = openagentd_prompt_for_mode(mode)
    if _looks_like_legacy_first_party_prompt(extra_prompt, name="openagentd"):
        return base
    return apply_builtin_extra_prompt(base, extra_prompt)


def apply_member_extra_prompt(name: str, base_prompt: str, extra_prompt: str) -> str:
    """Return built-in member prompt plus user-authored extra text."""
    if _looks_like_legacy_first_party_prompt(extra_prompt, name=name):
        return base_prompt
    return apply_builtin_extra_prompt(base_prompt, extra_prompt)

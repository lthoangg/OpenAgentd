"""Built-in system prompts for first-party agents."""

from __future__ import annotations

import re

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

CODING_CHILD_AGENT_PROTOCOL = """## Child Agent Operating Protocol

You are running autonomously inside an isolated git worktree for your assigned task.

- Work only inside your worktree directory.
- Commit your changes with clear, descriptive commit messages.
- When your task is complete and produced code changes, call `agent_merge` to merge your branch back into the parent repository.
- If `agent_merge` fails due to conflicts or dirty state, do not force — report the exact conflict details in your final summary.
- Always provide a concise, structured final response. Your final assistant message is delivered verbatim to your parent session.
- Do not ask user questions. If blocked, communicate with your parent session using `agent_send`.
"""

CODING_PARENT_DELEGATION_PROTOCOL = """## Multi-Agent Delegation Protocol

- When a task benefits from parallel exploration or isolated changes, delegate using `agent_spawn`.
- Spawned agents run in an isolated git worktree on their own branch.
- You can continue working on other tasks in parallel while child agents run.
- When child agents complete, their final report is delivered to your session asynchronously.
- Use `agent_list` to inspect active child sessions, `agent_send` to send follow-up instructions, or `agent_stop` to cancel a child.
"""


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

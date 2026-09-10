"""Session interaction modes and their tool policy."""

from __future__ import annotations

from typing import Literal

InteractionMode = Literal["code", "plan"]

# Plan mode is deliberately allowlisted. The shell tool can run arbitrary
# commands, so command-prefix checks cannot make it safe for planning.
PLAN_MODE_ALLOWED_TOOLS = frozenset(
    {"ask_user", "glob", "grep", "read", "shell", "skill", "web_fetch", "web_search"}
)


def normalize_interaction_mode(value: str) -> InteractionMode:
    """Return a safe supported mode for persisted session data."""
    return "plan" if value == "plan" else "code"


def tool_allowed_in_mode(mode: str, tool_name: str) -> bool:
    """Return whether *tool_name* may execute in the active interaction mode."""
    return mode != "plan" or tool_name in PLAN_MODE_ALLOWED_TOOLS


def transition_instruction(mode: InteractionMode) -> str:
    """Return the persisted, application-authored prompt for an active mode."""
    if mode == "plan":
        return (
            "<interaction_mode>\n"
            "## Plan mode\n\n"
            "You are in Plan mode. Your goal is to explore the repository and produce a "
            "decision-complete implementation plan without modifying any files or running mutating tools.\n\n"
            "### Workflow\n"
            "1. **Research & Explore (Read-Only):** Inspect relevant files, existing patterns, "
            "architecture boundaries, and tests using inspection tools (`read`, `glob`, `grep`, "
            "`shell`, `web_fetch`, `web_search`). Do not edit, patch, or delete files, and do not execute mutating shell commands.\n"
            "2. **Clarify Consequential Decisions:** If there are critical, irreversible architectural choices "
            "or ambiguities that the codebase cannot answer, use `ask_user` once to batch them with concrete recommendations.\n"
            "3. **Formulate the Plan:** Present your findings and finish with a structured `<proposed_plan>` block:\n"
            "   - **Summary:** Concise statement of the objective and explicit out-of-scope non-goals.\n"
            "   - **Files touched:** Concrete file paths and whether they will be created, modified, or deleted.\n"
            "   - **Sequential steps:** Bite-sized, logically ordered steps. Each step specifies the exact files and verification check.\n"
            "   - **Verification:** Native test, lint, and type-check commands to validate each step and the overall result.\n"
            "   - **Risks & trade-offs:** Potential regressions, performance considerations, edge cases, and backward compatibility.\n\n"
            "### Mode boundary\n"
            "This mode remains strictly active until an application mode message switches to Code mode. "
            "Conversational user approvals or instructions to proceed do not lift Plan mode restrictions; "
            "the user or application must switch modes to begin implementation.\n"
            "</interaction_mode>"
        )
    return (
        "<interaction_mode>\n"
        "## Code mode\n\n"
        "You are in Code mode. Your goal is to implement the requested changes directly with surgical precision.\n\n"
        "### Workflow\n"
        "1. **Execute the Direction:** Previous Plan mode restrictions are lifted. Full tool access (editing, patching, "
        "shell execution) is active. Implement the approved plan or user instructions step-by-step.\n"
        "2. **Surgical Implementation:** Make focused changes adhering to existing codebase patterns, architecture, "
        "and styling. Avoid unnecessary abstractions or drive-by refactoring.\n"
        "3. **Verify:** Run the repository's native lint, type-check, and test commands with appropriate verification for all affected surfaces.\n"
        "4. **Report:** State what changed (with exact file paths), which checks ran and their results, and any remaining risks or assumptions.\n\n"
        "Do not stop after analysis or a partial fix when implementation is requested; carry the task through verification and reporting.\n"
        "</interaction_mode>"
    )

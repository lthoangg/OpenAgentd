"""Inspect the static prompt/tool token budget for an agent — no server required.

Builds the stable request surface before conversation messages and provider
envelope conversion:
   1. system_prompt        — built-in/user prompt + date + team protocol
   2. tools                — base tools + runtime team-tool schemas
   3. builtin prompts      — every code-owned first-party prompt, separately
   4. bundled skills       — each on-demand skill body, separately

Output is a single JSON object:
  {
    "system_prompt": "...",
    "tools": [...],
    "stats": { ... }
  }

Token counts use tiktoken with ``o200k_base`` by default. They are exact for
that encoding; providers may tokenize the same payload differently.

Usage:
  uv run python -m manual.inspect_prompt
  uv run python -m manual.inspect_prompt --dir .openagentd/agents
  uv run python -m manual.inspect_prompt --agent explorer
  uv run python -m manual.inspect_prompt --no-date
  uv run python -m manual.inspect_prompt --date 2026-04-12
  uv run python -m manual.inspect_prompt --out .openagentd/chat/payload.json
  uv run python -m manual.inspect_prompt --stats-only
  uv run python -m manual.inspect_prompt --stats-only --json
  uv run python -m manual.inspect_prompt --prompt-only           # print just the system prompt
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def _default_agents_dir() -> str:
    """Return the configured agents directory.

    Falls back to ``.openagentd/config/agents`` (dev-mode default) if settings
    fail to import for some reason.
    """
    try:
        from app.core.config import settings

        return settings.AGENTS_DIR
    except Exception:
        return ".openagentd/config/agents"


DEFAULT_AGENTS_DIR = _default_agents_dir()


# ── Loader helpers ────────────────────────────────────────────────────────────


def _inject_date(prompt: str, date_str: str) -> str:
    """Replicate inject_current_date hook."""
    return f"{prompt}\n\nCurrent date (UTC): {date_str}"


# ── Stats ─────────────────────────────────────────────────────────────────────


def _budget_entry(text: str, encoding) -> dict[str, int]:
    """Return deterministic size metrics for *text* under *encoding*."""
    return {
        "chars": len(text),
        "bytes": len(text.encode("utf-8")),
        "tokens": len(encoding.encode(text, disallowed_special=())),
    }


def _sum_budgets(*entries: dict[str, int]) -> dict[str, int]:
    """Sum independently encoded payload sections without boundary merging."""
    return {
        key: sum(entry[key] for entry in entries)
        for key in ("chars", "bytes", "tokens")
    }


def _serialize_tools(
    tool_defs: list[dict], encoding
) -> tuple[str, dict[str, int], list[dict[str, int | str]]]:
    """Serialize tool schemas compactly and return aggregate/per-tool budgets."""
    serialized = json.dumps(tool_defs, ensure_ascii=False, separators=(",", ":"))
    items: list[dict[str, int | str]] = []
    for definition in tool_defs:
        text = json.dumps(definition, ensure_ascii=False, separators=(",", ":"))
        function = definition.get("function", {})
        items.append(
            {
                "name": str(function.get("name", "unknown")),
                **_budget_entry(text, encoding),
            }
        )
    return serialized, _budget_entry(serialized, encoding), items


def _inject_team_protocol(
    prompt: str, agent_cfg, *, lead_name: str = "openagentd"
) -> str:
    """Append the static team protocol used by the selected role."""
    from app.agent.mode.team.member import (
        LEAD_COMMUNICATION_RULES,
        LEAD_MESSAGE_FORMAT,
        LEAD_PROTOCOL,
        MEMBER_COMMUNICATION_RULES,
        MEMBER_MESSAGE_FORMAT,
        MEMBER_PROTOCOL,
    )

    if agent_cfg.role == "lead":
        protocol = "\n\n".join(
            [LEAD_COMMUNICATION_RULES, LEAD_MESSAGE_FORMAT, LEAD_PROTOCOL]
        )
    else:
        runtime_name = (
            agent_cfg.name
            if re.fullmatch(r"[^#,/\s]+#\d+", agent_cfg.name)
            else f"{agent_cfg.name}#1"
        )
        identity = (
            "## Runtime identity\n"
            f"You are `{runtime_name}`. Use this exact handle in reports; "
            "do not use the blueprint name."
        )
        protocol = "\n\n".join(
            [
                identity,
                MEMBER_COMMUNICATION_RULES,
                MEMBER_MESSAGE_FORMAT.format(lead_name=lead_name),
                MEMBER_PROTOCOL.format(lead_name=lead_name),
            ]
        )
    return f"{prompt}\n\n---\n\n{protocol}"


def _inject_team_tools(
    tool_defs: list[dict], agent_cfg, *, mode: str = "normal"
) -> list[dict]:
    """Apply the same name-based runtime tool overrides as a team run."""
    from app.agent.mode.team.mailbox import TeamMailbox
    from app.agent.mode.team.manage import make_team_manage_tool
    from app.agent.mode.team.tools import make_team_message_tool
    from app.agent.tools.builtin.todo import make_todo_manage_tool

    role = "lead" if agent_cfg.role == "lead" else "member"
    tools = {definition["function"]["name"]: definition for definition in tool_defs}
    mailbox = TeamMailbox()
    mailbox.register(agent_cfg.name)
    injected = [
        make_team_message_tool(mailbox, agent_name=agent_cfg.name, role=role),
        make_todo_manage_tool(role),
    ]
    # lsp navigation is currently detached from AgentTeam.get_injected_tools
    # (app/agent/mode/team/team.py) — mirrored here to match runtime.
    if role == "lead":
        injected.append(make_team_manage_tool(object()))  # schema does not read team
    for tool in injected:
        tools[tool.name] = tool.definition
    return list(tools.values())


def _builtin_skill_budgets(encoding) -> list[dict[str, int | str]]:
    """Count bundled skill bodies as stable, repository-trackable content."""
    from app.agent.tools.builtin.skill import (
        _builtin_skills_dir,
        _iter_skill_paths,
        _parse_frontmatter,
    )

    root = _builtin_skills_dir()
    items: list[dict[str, int | str]] = []
    for path, stem in _iter_skill_paths(root):
        text = path.read_text(encoding="utf-8")
        meta, body = _parse_frontmatter(text)
        name = str(meta.get("name", stem))
        items.append(
            {
                "name": name,
                "path": str(path.relative_to(root)),
                **_budget_entry(body, encoding),
            }
        )
    return items


def _builtin_prompt_budgets(encoding) -> list[dict[str, int | str]]:
    """Count every code-owned first-party base prompt independently."""
    from app.agent.builtin_prompts import (
        BUILTIN_MEMBER_PROFILES,
        CODING_OPENAGENTD_PROMPT,
    )

    prompts = {
        "coding/openagentd": CODING_OPENAGENTD_PROMPT,
    }
    for mode, profiles in BUILTIN_MEMBER_PROFILES.items():
        for name, profile in profiles.items():
            prompts[f"{mode}/{name}"] = profile["prompt"]
    return [
        {"name": name, **_budget_entry(prompt, encoding)}
        for name, prompt in sorted(prompts.items())
    ]


def _restrict_skill_catalog_to_builtins(tool_defs: list[dict]) -> list[dict]:
    """Return tool definitions with a stable bundled-only skill catalog."""
    from app.agent.tools.builtin.skill import _builtin_skills_dir, discover_skills

    skills = discover_skills(_builtin_skills_dir())
    catalog = "\n".join(
        ["## Available Skills"]
        + [
            f"- **{name}**: {info['description']}"
            for name, info in sorted(skills.items())
            if str(info.get("description", "")).strip()
        ]
    )
    description = "\n".join(
        [
            "Load a specialized skill that provides domain-specific instructions and workflows.",
            "",
            "When a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
            "Call this at most once per skill. If the same skill was already loaded earlier in the visible conversation, reuse those instructions instead of calling this tool again; repeated loads return the same content.",
            "",
            catalog,
        ]
    )
    rewritten = copy.deepcopy(tool_defs)
    for definition in rewritten:
        function = definition.get("function", {})
        if function.get("name") == "skill":
            function["description"] = description
            break
    return rewritten


def _print_stats(
    stats: dict,
) -> None:
    prompt = stats["system_prompt"]
    tools = stats["tools"]
    baseline = stats["baseline"]
    print(
        f"\nAgent: {stats['agent']}  model: {stats['model']}  "
        f"encoding: {stats['encoding']}",
        file=sys.stderr,
    )
    print(
        f"  system_prompt       : {prompt['chars']:>7,} chars  {prompt['tokens']:>7,} tokens",
        file=sys.stderr,
    )
    print(
        f"  tools JSON          : {tools['chars']:>7,} chars  {tools['tokens']:>7,} tokens",
        file=sys.stderr,
    )
    print(f"  tool_count          : {tools['count']:>7,}", file=sys.stderr)
    print("\n  tools:", file=sys.stderr)
    for tool in tools["items"]:
        print(
            f"    {tool['name']:<20} {tool['chars']:>7,} chars  {tool['tokens']:>7,} tokens",
            file=sys.stderr,
        )
    print(f"  {'─' * 49}", file=sys.stderr)
    print(
        f"  baseline total      : {baseline['chars']:>7,} chars  {baseline['tokens']:>7,} tokens",
        file=sys.stderr,
    )
    print("\n  builtin base prompts (reported separately):", file=sys.stderr)
    for prompt in stats["builtin_prompts"]["items"]:
        print(
            f"    {prompt['name']:<20} {prompt['chars']:>7,} chars  {prompt['tokens']:>7,} tokens",
            file=sys.stderr,
        )
    print("\n  bundled skill bodies (on demand; excluded above):", file=sys.stderr)
    for skill in stats["builtin_skills"]["items"]:
        print(
            f"    {skill['name']:<20} {skill['chars']:>7,} chars  {skill['tokens']:>7,} tokens",
            file=sys.stderr,
        )
    print(
        "\n  scope: static system prompt + OpenAI-style tool schema; "
        "excludes messages and provider envelope overhead",
        file=sys.stderr,
    )
    print(file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(
        description="Inspect system-prompt, tool-schema, and builtin-skill token budgets"
    )
    p.add_argument(
        "--dir",
        default=DEFAULT_AGENTS_DIR,
        metavar="DIR",
        help=f"Agents directory with .md files (default: {DEFAULT_AGENTS_DIR})",
    )
    p.add_argument(
        "--agent",
        metavar="NAME",
        help="Agent name to inspect (default: lead agent)",
    )
    p.add_argument(
        "--no-date",
        action="store_true",
        help="Skip date injection (show base prompt only)",
    )
    p.add_argument(
        "--date",
        metavar="YYYY-MM-DD",
        help="Override injected date (default: today UTC)",
    )
    p.add_argument(
        "--out",
        metavar="FILE",
        help="Write JSON output to a file instead of stdout",
    )
    p.add_argument(
        "--stats-only",
        action="store_true",
        help="Print char/token estimates only — no JSON output",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="With --stats-only, write the machine-readable budget to stdout",
    )
    p.add_argument(
        "--encoding",
        default="o200k_base",
        help="tiktoken encoding used for counts (default: o200k_base)",
    )
    p.add_argument(
        "--no-team-protocol",
        action="store_true",
        help="Exclude the runtime team protocol and injected team tools",
    )
    p.add_argument(
        "--skills-scope",
        choices=("current", "builtin"),
        default="current",
        help="Skill catalog included in the skill tool schema (default: current)",
    )
    p.add_argument(
        "--prompt-only",
        action="store_true",
        help="Print just the system prompt (plain text) and exit",
    )
    args = p.parse_args()

    agents_dir = Path(args.dir)
    if not agents_dir.exists():
        print(f"Error: agents directory not found: {agents_dir}", file=sys.stderr)
        sys.exit(1)

    from app.agent.loader import parse_agent_md

    md_files = sorted(agents_dir.glob("*.md"))
    if not md_files:
        print(f"Error: no .md files in {agents_dir}", file=sys.stderr)
        sys.exit(1)

    configs = []
    for md_path in md_files:
        try:
            cfg = parse_agent_md(md_path)
            configs.append(cfg)
        except Exception as exc:
            print(f"Warning: failed to parse {md_path.name}: {exc}", file=sys.stderr)

    if not configs:
        print("Error: no valid agent configs found", file=sys.stderr)
        sys.exit(1)

    # Select agent
    if args.agent:
        matches = [c for c in configs if c.name == args.agent]
        if not matches:
            names = [c.name for c in configs]
            print(
                f"Error: agent '{args.agent}' not found. Available: {names}",
                file=sys.stderr,
            )
            sys.exit(1)
        agent_cfg = matches[0]
    else:
        # Default to lead
        leads = [c for c in configs if c.role == "lead"]
        agent_cfg = leads[0] if leads else configs[0]

    # List all discovered agents
    print(f"\nDiscovered agents in {agents_dir}:", file=sys.stderr)
    for cfg in configs:
        marker = " <--" if cfg.name == agent_cfg.name else ""
        print(
            f"  {cfg.name:15s} role={cfg.role:6s} model={cfg.model or '(none)'}{marker}",
            file=sys.stderr,
        )
    print(file=sys.stderr)

    # 1. System prompt — use the same runtime expansion as loader._build_agent
    #    so builtin prompts, member profiles, and skill tool descriptions are
    #    all reflected accurately.
    from app.agent.loader import _build_agent, _default_tool_registry
    from app.agent.providers.factory import build_provider

    _tool_registry = _default_tool_registry()
    _mode = "coding" if Path(args.dir).name == "coding" else "normal"
    _expanded_agent = _build_agent(
        agent_cfg, _tool_registry, build_provider, mode=_mode
    )
    system_prompt = _expanded_agent.system_prompt

    # 2. Date injection (first runtime prompt hook).
    if not args.no_date:
        date_str = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        system_prompt = _inject_date(system_prompt, date_str)

    # 3. Team protocol and runtime tools. Team protocol follows date injection
    # in TeamMemberBase._handle_messages().
    if not args.no_team_protocol:
        lead_cfg = next((cfg for cfg in configs if cfg.role == "lead"), agent_cfg)
        system_prompt = _inject_team_protocol(
            system_prompt, agent_cfg, lead_name=lead_cfg.name
        )

    # Early exit for focused inspection
    if args.prompt_only:
        print(system_prompt)
        return

    # 4. Tool definitions — constructor tools plus runtime-injected team tools.
    tool_defs = [t.definition for t in _expanded_agent._tools.values()]
    if not args.no_team_protocol:
        tool_defs = _inject_team_tools(tool_defs, agent_cfg, mode=_mode)
    if args.skills_scope == "builtin":
        tool_defs = _restrict_skill_catalog_to_builtins(tool_defs)

    try:
        import tiktoken

        encoding = tiktoken.get_encoding(args.encoding)
    except (ImportError, ValueError) as exc:
        print(
            f"Error: cannot load tiktoken encoding '{args.encoding}': {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    tools_json, tools_budget, tool_items = _serialize_tools(tool_defs, encoding)
    prompt_budget = _budget_entry(system_prompt, encoding)
    builtin_prompts = _builtin_prompt_budgets(encoding)
    builtin_skills = _builtin_skill_budgets(encoding)

    stats = {
        "agent": agent_cfg.name,
        "model": agent_cfg.model,
        "role": agent_cfg.role,
        "encoding": args.encoding,
        "skills_scope": args.skills_scope,
        "team_protocol": not args.no_team_protocol,
        "scope": (
            "Static system prompt and compact OpenAI-style tool definitions; "
            "excludes conversation messages and provider envelope overhead."
        ),
        "system_prompt": prompt_budget,
        "tools": {
            **tools_budget,
            "count": len(tool_defs),
            "items": tool_items,
        },
        "baseline": _sum_budgets(prompt_budget, tools_budget),
        "builtin_prompts": {
            "scope": "Code-owned base prompts before team/date/workspace injection.",
            "count": len(builtin_prompts),
            "items": builtin_prompts,
        },
        "builtin_skills": {
            "scope": "Skill body after frontmatter, before runtime path expansion.",
            "count": len(builtin_skills),
            "items": builtin_skills,
        },
    }

    payload = {
        "system_prompt": system_prompt,
        "tools": tool_defs,
        "stats": stats,
    }
    output = json.dumps(payload, indent=2, ensure_ascii=False)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output, encoding="utf-8")
        print(f"Written to {out_path}", file=sys.stderr)
    elif args.stats_only and args.json:
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    elif not args.stats_only:
        print(output)

    # Print stats last so they appear as a summary after the JSON payload
    _print_stats(stats)


if __name__ == "__main__":
    main()

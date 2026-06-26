"""Reconstruct the full LLM payload for an agent — no server required.

Produces the exact things sent to the provider on every request:
   1. system_prompt        — base prompt + date injection (what the LLM sees)
   2. tools                — JSON array of tool definitions (as sent in the API body)

Output is a single JSON object:
  {
    "system_prompt": "...",
    "tools": [...],
    "stats": { ... }
  }

Paste system_prompt + tools JSON into https://platform.openai.com/tokenizer
(or tiktoken) to get an accurate token count.

Usage:
  uv run python -m manual.inspect_prompt
  uv run python -m manual.inspect_prompt --dir .openagentd/agents
  uv run python -m manual.inspect_prompt --agent explorer
  uv run python -m manual.inspect_prompt --no-date
  uv run python -m manual.inspect_prompt --date 2026-04-12
  uv run python -m manual.inspect_prompt --out .openagentd/chat/payload.json
  uv run python -m manual.inspect_prompt --stats-only
  uv run python -m manual.inspect_prompt --prompt-only           # print just the system prompt
"""

from __future__ import annotations

import argparse
import json
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


def _estimate_tokens(text: str) -> int:
    """Rough estimate: ~4 chars per token (GPT-3/4 average for English+JSON)."""
    return len(text) // 4


def _print_stats(
    system_prompt: str,
    tools_json: str,
    agent: str,
    model: str,
) -> None:
    sp_chars = len(system_prompt)
    t_chars = len(tools_json)
    total = sp_chars + t_chars
    print(f"\nAgent: {agent}  model: {model}", file=sys.stderr)
    print(
        f"  system_prompt       : {sp_chars:>7,} chars  (~{_estimate_tokens(system_prompt):,} tokens)",
        file=sys.stderr,
    )
    print(
        f"  tools JSON          : {t_chars:>7,} chars  (~{_estimate_tokens(tools_json):,} tokens)",
        file=sys.stderr,
    )
    print(
        f"  tool_count          : {tools_json.count('"type": "function"')}",
        file=sys.stderr,
    )
    print(f"  {'─' * 49}", file=sys.stderr)
    print(
        f"  total (prompt+tools): {total:>7,} chars  (~{_estimate_tokens(system_prompt + tools_json):,} tokens)",
        file=sys.stderr,
    )
    print(file=sys.stderr)


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(
        description="Reconstruct the full LLM payload (system prompt + tools) for an agent"
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

    # 2. Date injection
    if not args.no_date:
        date_str = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        system_prompt = _inject_date(system_prompt, date_str)

    # Early exit for focused inspection
    if args.prompt_only:
        print(system_prompt)
        return

    # 3. Tool definitions — taken from the expanded agent to match runtime exactly
    tool_defs = [t.definition for t in _expanded_agent._tools.values()]
    tools_json = json.dumps(tool_defs, indent=2, ensure_ascii=False)

    payload = {
        "system_prompt": system_prompt,
        "tools": tool_defs,
        "stats": {
            "system_prompt_chars": len(system_prompt),
            "tools_json_chars": len(tools_json),
            "total_chars": len(system_prompt) + len(tools_json),
            "tool_count": len(tool_defs),
            "agent": agent_cfg.name,
            "model": agent_cfg.model,
            "role": agent_cfg.role,
        },
    }
    output = json.dumps(payload, indent=2, ensure_ascii=False)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output, encoding="utf-8")
        print(f"Written to {out_path}", file=sys.stderr)
    elif not args.stats_only:
        print(output)

    # Print stats last so they appear as a summary after the JSON payload
    _print_stats(
        system_prompt,
        tools_json,
        agent_cfg.name,
        agent_cfg.model or "(none)",
    )


if __name__ == "__main__":
    main()

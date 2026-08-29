"""Print per-message usage metadata for an agent session.

Usage:
  uv run python -m manual.team_usage SESSION_ID
"""

from __future__ import annotations

import argparse

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


def load_history(base: str, sid: str) -> tuple[dict, list[dict]]:
    pages: list[dict] = []
    before: str | None = None
    while True:
        params = {"before": before} if before else {}
        r = httpx.get(f"{base}/agent/{sid}/history", params=params)
        r.raise_for_status()
        data = r.json()
        pages.append(data)
        if not data.get("has_more") or not data.get("next_cursor"):
            break
        before = data["next_cursor"]
    pages.reverse()

    lead = {"name": "openagentd", "messages": []}
    for page in pages:
        page_lead = page["lead"]
        lead["name"] = (
            page_lead.get("agent_name") or page_lead.get("name") or "openagentd"
        )
        lead["messages"].extend(page_lead["messages"])
    return lead, []


def print_usage(agent_name: str, messages: list[dict]) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {agent_name}")
    print(f"{'=' * 60}")
    for i, m in enumerate(messages, 1):
        extra = m.get("extra") or {}
        usage = extra.get("usage") if isinstance(extra, dict) else None
        model = extra.get("model") if isinstance(extra, dict) else None
        if not usage:
            continue
        print(
            f"{i:>3}. role={m.get('role')}"
            f" model={model!r}"
            f" input={usage.get('input')}"
            f" output={usage.get('output')}"
            f" total={usage.get('total')}"
            f" cache={usage.get('cache')}"
            f" thoughts={usage.get('thoughts')}"
            f" tool_use={usage.get('tool_use')}"
        )


def main() -> None:
    p = argparse.ArgumentParser(description="Print stored usage metadata for a session")
    p.add_argument("session_id", help="Session ID")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    lead, _ = load_history(base, args.session_id)
    print_usage(lead["name"], lead["messages"])


if __name__ == "__main__":
    main()

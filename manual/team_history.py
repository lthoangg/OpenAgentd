"""Print full history for an agent session.

Usage: uv run python -m manual.team_history SESSION_ID
"""

import argparse

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


def print_history(base: str, sid: str):
    pages: list = []
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

    lead_messages: list = []
    lead_name: str = "openagentd"
    for page in pages:
        lead = page["lead"]
        lead_name = lead.get("agent_name") or lead.get("name") or "openagentd"
        lead_messages.extend(lead["messages"])

    _print_agent(lead_name, lead_messages)
    print(f"\ntotal: {len(lead_messages)} msgs")


def _print_agent(name: str, messages: list):
    print(f"\n{'=' * 60}")
    print(f"  {name}: {len(messages)} msgs")
    print("=" * 60)
    for i, m in enumerate(messages, 1):
        role = m["role"]
        content = (m.get("content") or "")[:140]
        tc = m.get("tool_calls")

        if tc:
            for t in tc:
                fn = t["function"]["name"]
                args = t["function"]["arguments"][:120]
                print(f"  {i:2d}. [{role}] CALL {fn}({args})")
        else:
            print(f"  {i:2d}. [{role}] {content}")


def main():
    p = argparse.ArgumentParser(description="Print agent session history")
    p.add_argument("session_id", help="Session ID")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    print_history(base, args.session_id)


if __name__ == "__main__":
    main()

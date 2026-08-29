"""Inspect agent sessions: list and full history.

Tests: GET /agent/sessions, GET /agent/{id}/history.

Usage:
  uv run python -m manual.team_sessions              # list first page (default 10)
  uv run python -m manual.team_sessions --all        # walk all pages via cursor, print summary
  uv run python -m manual.team_sessions --id ID      # full history for a session
"""

import argparse

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


def list_team_sessions(base: str, limit: int, before: str | None = None) -> dict:
    params: dict = {"limit": limit}
    if before:
        params["before"] = before
    r = httpx.get(f"{base}/agent/sessions", params=params)
    r.raise_for_status()
    return r.json()


def print_page(data: dict):
    sessions = data["data"]
    has_more = data.get("has_more", False)
    next_cursor = data.get("next_cursor")
    print(f"\nsessions (count={len(sessions)} has_more={has_more}):")
    print("-" * 70)
    for s in sessions:
        title = s["title"][:55] if s.get("title") else "(no title)"
        model = s.get("model") or "-"
        print(f"  {s['id']}  model={model}  {title}")
    if has_more and next_cursor:
        print(f"\n  more available — use --before {next_cursor}")


def list_all(base: str, limit: int):
    cursor: str | None = None
    total_fetched = 0

    while True:
        data = list_team_sessions(base, limit, before=cursor)
        sessions = data["data"]
        total_fetched += len(sessions)
        if not sessions or not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
        if not cursor:
            break

    print(f"\ntotal sessions fetched: {total_fetched}")


def print_history(base: str, session_id: str):
    r = httpx.get(f"{base}/agent/{session_id}/history", params={"limit": 1000})
    if r.status_code == 404:
        print(f"404: history for {session_id} not found")
        return
    r.raise_for_status()
    data = r.json()

    lead = data["lead"]
    lead_name = lead.get("agent_name") or lead.get("name") or "openagentd"
    _print_agent_msgs(lead_name, lead["messages"])

    print(f"\ntotal messages: {len(lead['messages'])}")


def _print_agent_msgs(name: str, messages: list):
    print(f"\n{'=' * 60}")
    print(f"  {name}: {len(messages)} msgs")
    print("=" * 60)
    for i, m in enumerate(messages, 1):
        role = m["role"]
        content = (m.get("content") or "")[:120]
        tc = m.get("tool_calls")
        if tc:
            for t in tc:
                print(
                    f"  {i:2d}. [{role}] CALL {t['function']['name']}({t['function']['arguments'][:80]})"
                )
        else:
            print(f"  {i:2d}. [{role}] {content}")


def main():
    p = argparse.ArgumentParser(description="Sessions list + full history")
    p.add_argument("--id", default=None, help="Full history for a session")
    p.add_argument("--limit", type=int, default=10, help="Page size (default 10)")
    p.add_argument(
        "--before",
        default=None,
        help="Cursor: ISO 8601 created_at — fetch sessions older than this",
    )
    p.add_argument(
        "--all", action="store_true", help="Walk all pages via cursor, print summary"
    )
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    if args.id:
        print_history(base, args.id)
        return

    if args.all:
        list_all(base, args.limit)
        return

    data = list_team_sessions(base, args.limit, before=args.before)
    print_page(data)


if __name__ == "__main__":
    main()

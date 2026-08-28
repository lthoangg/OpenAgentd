"""Print full team history for a session.

Usage: uv run python -m manual.team_history SESSION_ID
"""

import argparse

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE


def print_history(base: str, sid: str):
    # Me walk cursor pages oldest-first: collect all pages then print in order.
    pages: list = []
    before: str | None = None
    while True:
        params = {"before": before} if before else {}
        r = httpx.get(f"{base}/session/{sid}/history", params=params)
        r.raise_for_status()
        data = r.json()
        pages.append(data)
        if not data.get("has_more") or not data.get("next_cursor"):
            break
        before = data["next_cursor"]

    # Pages arrive newest-first (each page is older than the previous), so
    # reverse to get chronological order before merging.
    pages.reverse()

    # Merge messages across pages for the requested session.
    messages: list = []
    session_name: str = ""
    for page in pages:
        session = page["session"]
        session_name = session.get("agent_name") or session.get("name") or "session"
        messages.extend(session["messages"])

    _print_agent(session_name, messages)

    total = len(messages)
    done_ct = sum(1 for message in messages if message.get("content") == "[DONE]")
    social_ct = 0

    # Count unique IDs.
    all_ids = [message["id"] for message in messages]
    dupes = len(all_ids) - len(set(all_ids))

    print("\n--- summary ---")
    print(f"total: {total} | [DONE]: {done_ct} | dupes: {dupes} | social: {social_ct}")


def _print_agent(name: str, messages: list):
    print(f"\n{'=' * 60}")
    print(f"  {name}: {len(messages)} msgs")
    print("=" * 60)
    for i, m in enumerate(messages, 1):
        role = m["role"]
        content = (m.get("content") or "")[:140]
        extra = m.get("extra")
        tc = m.get("tool_calls")

        if tc:
            for t in tc:
                fn = t["function"]["name"]
                args = t["function"]["arguments"][:120]
                print(f"  {i:2d}. [{role}] CALL {fn}({args})")
        elif role == "user" and extra:
            # Me support both old (from_agent) and new (from_agents) format
            frm = extra.get("from_agent") or ",".join(extra.get("from_agents", ["?"]))
            bcast = " [broadcast]" if extra.get("is_broadcast") else ""
            print(f"  {i:2d}. [{role}] from={frm}{bcast} | {content}")
        else:
            print(f"  {i:2d}. [{role}] {content}")


def main():
    p = argparse.ArgumentParser(description="Print team session history")
    p.add_argument("session_id", help="Team session ID")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    print_history(base, args.session_id)


if __name__ == "__main__":
    main()

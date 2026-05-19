"""Print full team history for a session.

Usage: uv run python -m manual.team_history SESSION_ID
"""

import argparse

import httpx

BASE = "http://localhost:8000/api"


def print_history(base: str, sid: str):
    # Me walk cursor pages oldest-first: collect all pages then print in order.
    pages: list = []
    before: str | None = None
    while True:
        params = {"before": before} if before else {}
        r = httpx.get(f"{base}/team/{sid}/history", params=params)
        r.raise_for_status()
        data = r.json()
        pages.append(data)
        if not data.get("has_more") or not data.get("next_cursor"):
            break
        before = data["next_cursor"]

    # Pages arrive newest-first (each page is older than the previous), so
    # reverse to get chronological order before merging.
    pages.reverse()

    # Merge messages across pages per agent.
    lead_messages: list = []
    members_messages: dict[str, list] = {}
    lead_name: str = ""
    for page in pages:
        lead = page["lead"]
        lead_name = lead["agent_name"]
        lead_messages.extend(lead["messages"])
        for mb in page.get("members", []):
            members_messages.setdefault(mb["name"], []).extend(mb["messages"])

    _print_agent(lead_name, lead_messages, is_lead=True)
    for name, msgs in members_messages.items():
        _print_agent(name, msgs)

    all_member_msgs = list(members_messages.values())
    total = len(lead_messages) + sum(len(msgs) for msgs in all_member_msgs)
    done_ct = sum(
        1
        for msgs in all_member_msgs
        for m in msgs
        if m.get("content") == "[DONE]"
    )
    social_ct = 0
    for msgs in all_member_msgs:
        for m in msgs:
            for t in m.get("tool_calls") or []:
                if t["function"]["name"] == "send_message":
                    a = t["function"]["arguments"].lower()
                    if any(
                        w in a
                        for w in ["hello", "ready", "hi ", "ok", "chào", "sẵn sàng"]
                    ):
                        social_ct += 1

    # Me count unique IDs
    all_ids = [m["id"] for m in lead_messages]
    for msgs in all_member_msgs:
        all_ids += [m["id"] for m in msgs]
    dupes = len(all_ids) - len(set(all_ids))

    print("\n--- summary ---")
    print(f"total: {total} | [DONE]: {done_ct} | dupes: {dupes} | social: {social_ct}")


def _print_agent(name: str, messages: list, *, is_lead: bool = False):
    label = f"{name} [lead]" if is_lead else name
    print(f"\n{'=' * 60}")
    print(f"  {label}: {len(messages)} msgs")
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

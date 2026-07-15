"""Test SummarizationHook by inspecting DB for is_summary rows.

This script does NOT restart the server. It assumes you started the server
with a low ``DEFAULT_PROMPT_TOKEN_THRESHOLD`` so summarization fires during
the test. There is no file-based configuration for this threshold.

Usage:
  # 1. In ``app/agent/hooks/summarization.py``, set:
  #        DEFAULT_PROMPT_TOKEN_THRESHOLD = 2000
  #    Then start the server (in another terminal):
  #        uv run python -m app.server
  #
  # 2. Run this script:
  uv run python -m manual.summarization_test
  uv run python -m manual.summarization_test --session ID   # inspect existing session
  uv run python -m manual.summarization_test --db PATH      # custom DB path

What it checks:
  - Sends enough messages to exceed a ~2000-token threshold
  - Fetches raw DB rows (via /chat/sessions/{id} won't show is_summary rows)
  - Queries the SQLite DB directly to find is_summary=True rows
  - Verifies that excluded messages are still visible in DB but not in API
"""

import argparse
import sqlite3
import time

import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_DB = "openagentd.db"
DEFAULT_WAIT = 90

# Me use long prompts to burn tokens fast
WARM_UP_MESSAGES = [
    "Write a detailed 200-word biography of Albert Einstein.",
    "Now write a 200-word summary of the theory of relativity.",
    "Write 200 words about the photoelectric effect and its importance.",
    "Explain quantum entanglement in 200 words.",
    "Summarize the Manhattan Project in 200 words.",
]


def post_and_wait(
    base: str, message: str, session_id: str | None, timeout: int
) -> tuple[str, bool]:
    payload: dict = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    r = httpx.post(f"{base}/chat", data=payload)
    r.raise_for_status()
    sid = r.json()["session_id"]

    # Me wait for done
    start = time.monotonic()
    done = False
    try:
        with httpx.stream(
            "GET", f"{base}/chat/stream/{sid}", timeout=timeout + 5
        ) as resp:
            for line in resp.iter_lines():
                if time.monotonic() - start > timeout:
                    break
                if line.startswith("event:") and "done" in line:
                    done = True
                    break
    except httpx.ReadTimeout:
        pass

    elapsed = time.monotonic() - start
    return sid, done, elapsed


def get_api_messages(base: str, sid: str) -> list:
    r = httpx.get(f"{base}/chat/sessions/{sid}")
    r.raise_for_status()
    return r.json()["messages"]


def get_db_messages(db_path: str, sid: str) -> list:
    # Me read directly from SQLite
    # Me strip hyphens — SQLite stores UUIDs without them
    sid_plain = sid.replace("-", "")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        """
        SELECT id, role, content, is_summary, exclude_from_context, created_at
        FROM session_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        """,
        (sid_plain,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def print_db_summary(rows: list):
    print(f"\n{'=' * 60}")
    print(f"  DB messages ({len(rows)} total)")
    print("=" * 60)
    for i, m in enumerate(rows, 1):
        flags = []
        if m["is_summary"]:
            flags.append("IS_SUMMARY")
        if m["exclude_from_context"]:
            flags.append("EXCLUDED")
        flag_str = f"  [{', '.join(flags)}]" if flags else ""
        content = (m["content"] or "")[:80]
        print(f"  {i:2d}. [{m['role']}]{flag_str} {content}")


def check_summarization(rows: list) -> bool:
    summary_rows = [r for r in rows if r["is_summary"]]
    excluded_rows = [r for r in rows if r["exclude_from_context"]]

    print(f"\n--- summarization check ---")
    print(f"  is_summary rows:          {len(summary_rows)}")
    print(f"  exclude_from_context rows: {len(excluded_rows)}")

    if summary_rows:
        print(f"\n  summary content:")
        for r in summary_rows:
            print(f"    {(r['content'] or '')[:200]}")
        return True
    else:
        print(f"\n  WARN: no summarization triggered.")
        print(
            "  Did you set DEFAULT_PROMPT_TOKEN_THRESHOLD = 2000 in "
            "app/agent/hooks/summarization.py before starting the server?"
        )
        return False


def main():
    p = argparse.ArgumentParser(description="Summarization smoke test")
    p.add_argument(
        "--session", default=None, help="Inspect existing session (skip sending)"
    )
    p.add_argument("--db", default=DEFAULT_DB, help="SQLite DB path")
    p.add_argument("--wait", type=int, default=DEFAULT_WAIT)
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    if args.session:
        # Me inspect existing session only
        sid = args.session
        print(f"inspecting session: {sid}")
    else:
        # Me send warm-up messages to burn tokens
        sid = None
        print("sending warm-up messages to trigger summarization...")
        for i, msg in enumerate(WARM_UP_MESSAGES, 1):
            print(f"  [{i}/{len(WARM_UP_MESSAGES)}] {msg[:60]}...", end="", flush=True)
            sid, done, elapsed = post_and_wait(base, msg, sid, args.wait)
            status = "ok" if done else "TIMEOUT"
            print(f" {status} ({elapsed:.1f}s)")

        print(f"\nsession: {sid}")

    # Me check API response (should hide is_summary rows)
    api_msgs = get_api_messages(base, sid)
    print(f"\nAPI /chat/sessions/{sid}: {len(api_msgs)} visible messages")
    api_summary_count = sum(1 for m in api_msgs if m.get("is_summary"))
    if api_summary_count:
        print(
            f"  WARNING: API returned {api_summary_count} is_summary rows (should be 0)"
        )
    else:
        print(f"  OK: no is_summary rows in API response")

    # Me check DB directly
    try:
        db_rows = get_db_messages(args.db, sid)
        print_db_summary(db_rows)
        triggered = check_summarization(db_rows)

        # Me verify API hides summary rows
        db_total = len(db_rows)
        api_total = len(api_msgs)
        db_summary_ct = sum(1 for r in db_rows if r["is_summary"])
        expected_api = db_total - db_summary_ct
        if api_total == expected_api:
            print(
                f"\n  PASS: API hides summary rows ({db_total} DB - {db_summary_ct} summary = {api_total} shown)"
            )
        else:
            print(
                f"\n  WARN: DB={db_total}, summaries={db_summary_ct}, expected API={expected_api}, got={api_total}"
            )

    except Exception as e:
        print(f"\n  DB read failed: {e}")
        print(f"  Run with --db PATH to specify correct SQLite file.")
        print(f"  Tip: find openagentd.db with:  find . -name '*.db'")


if __name__ == "__main__":
    main()

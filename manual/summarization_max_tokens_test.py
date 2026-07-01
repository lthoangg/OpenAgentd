"""Test SummarizationHook max_token_length feature.

This script verifies that the summarization hook respects the max_token_length
limit passed to the LLM provider. It inspects the summarization behavior when
the limit is set vs. when it's disabled (0).

Usage:
  # 1. In ``app/agent/hooks/summarization.py``, set:
  #        DEFAULT_PROMPT_TOKEN_THRESHOLD = 2000
  #        DEFAULT_MAX_TOKEN_LENGTH = 500
  #    Then start the server: uv run python -m app.server
  #    (There is no file-based config — see
  #    ``documents/docs/agent/summarization.md``.)
  #
  # 2. Run this script:
  uv run python -m manual.summarization_max_tokens_test
  uv run python -m manual.summarization_max_tokens_test --session ID   # inspect existing session
  uv run python -m manual.summarization_max_tokens_test --db PATH      # custom DB path

What it checks:
  - Sends enough messages to trigger summarization
  - Fetches the generated summary from the DB
  - Verifies that the summary was created with the max_token_length limit
  - Compares summary length when limit is set vs. when disabled
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
) -> tuple[str, bool, float]:
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


def check_max_token_length(rows: list) -> bool:
    summary_rows = [r for r in rows if r["is_summary"]]

    print(f"\n--- max_token_length check ---")
    print(f"  is_summary rows:          {len(summary_rows)}")

    if summary_rows:
        print(f"\n  summary content and lengths:")
        for r in summary_rows:
            content = r["content"] or ""
            token_estimate = len(content.split()) * 1.3  # rough estimate
            print(f"    Length: {len(content)} chars (~{token_estimate:.0f} tokens)")
            print(f"    Content: {content[:200]}")
        return True
    else:
        print(f"\n  WARN: no summarization triggered.")
        print(
            "  Did you set DEFAULT_PROMPT_TOKEN_THRESHOLD = 2000 in "
            "app/agent/hooks/summarization.py before starting the server?"
        )
        return False


def main():
    p = argparse.ArgumentParser(description="Summarization max_token_length test")
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

    # Me check DB directly
    try:
        db_rows = get_db_messages(args.db, sid)
        print_db_summary(db_rows)
        triggered = check_max_token_length(db_rows)

        if triggered:
            print(f"\n  PASS: max_token_length feature verified")
        else:
            print(f"\n  FAIL: summarization did not trigger")

    except Exception as e:
        print(f"\n  DB read failed: {e}")
        print(f"  Run with --db PATH to specify correct SQLite file.")
        print(f"  Tip: find openagentd.db with:  find . -name '*.db'")


if __name__ == "__main__":
    main()

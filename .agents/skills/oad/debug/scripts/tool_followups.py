#!/usr/bin/env python3
"""Bad tool results, and what the agent thought and did right after them.

Usage:
    python3 .agents/skills/oad/debug/scripts/tool_followups.py [--days 7] [--tool shell]
        [--samples 3] [--db PATH]

Logs and spans do not keep tool output or reasoning; the session database does.
For each tool result in ``session_messages`` this classifies the output (failed exit,
timeout, sandbox block, zsh ``no matches found``, empty success, truncated) and,
for a few random samples per class, prints the command that produced it plus the
next assistant row's ``reasoning_content`` and first tool call. Read-only
(``mode=ro``). Reasoning is empty when the model or thinking level returns none;
fall back to the next tool call then.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path

CANDIDATES = [
    Path(os.environ.get("OPENAGENTD_DATA_DIR", "~/.local/share/openagentd")).expanduser() / "openagentd.db",
    Path(".openagentd/dev/data/openagentd.db"),
]

CLASSIFY = """
case
  when content like 'Error: Sandbox%' then 'sandbox'
  when content like '%no matches found:%' then 'zsh-nomatch'
  when content like '[Timed out%' then 'timeout'
  when content like '[Failed — exit code%' then 'failed-exit'
  when content like 'Error:%' then 'error'
  when trim(replace(replace(content, '[Succeeded]', ''), char(10), '')) = '' then 'empty-success'
  when content like '%output truncated%' then 'truncated'
  else 'ok'
end
"""


def one_line(s: str | None, n: int) -> str:
    return " ".join((s or "").split())[:n]


def first_call(tool_calls: str | None) -> str:
    try:
        call = json.loads(tool_calls or "[]")[0]["function"]
        return f"{call.get('name')} {call.get('arguments')}"
    except (ValueError, IndexError, KeyError, TypeError):
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description="Bad tool results and the agent's next move.")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--tool", default="shell")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--db", type=Path)
    a = ap.parse_args()
    db = a.db or next((p for p in CANDIDATES if p.exists()), None)
    if not db:
        raise SystemExit("no openagentd.db found; pass --db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    where = "role = 'tool' and name = ? and created_at > datetime('now', ?)"
    args = (a.tool, f"-{a.days} days")
    print(f"=== {a.tool} results, last {a.days}d ({db}) ===")
    rows = con.execute(f"select {CLASSIFY} k, count(*), count(distinct session_id) from session_messages where {where} group by k order by 2 desc", args).fetchall()
    for k, n, sessions in rows:
        print(f"  {k:<14} {n:>7}  ({sessions} sessions)")
    for k, _, _ in rows:
        if k == "ok":
            continue
        print(f"\n--- {k} ---")
        samples = con.execute(
            f"select session_id, seq, content from session_messages where {where} and {CLASSIFY} = ? order by random() limit ?",
            (*args, k, a.samples),
        ).fetchall()
        for sid, seq, content in samples:
            prev = con.execute("select tool_calls from session_messages where session_id = ? and role = 'assistant' and seq < ? order by seq desc limit 1", (sid, seq)).fetchone()
            nxt = con.execute("select reasoning_content, content, tool_calls from session_messages where session_id = ? and role = 'assistant' and seq > ? order by seq limit 1", (sid, seq)).fetchone()
            print(f"  session {sid}")
            print(f"    call:     {one_line(first_call(prev[0] if prev else None), 240)}")
            print(f"    result:   {one_line(content, 240)}")
            if nxt:
                print(f"    thinking: {one_line(nxt[0], 400) or '(none)'}")
                print(f"    next:     {one_line(nxt[1], 160) or one_line(first_call(nxt[2]), 240)}")


if __name__ == "__main__":
    main()

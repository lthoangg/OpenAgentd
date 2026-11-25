"""``round_trips.py`` splits lookup work by role: the main agent and each subagent profile."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / ".agents/skills/oad/debug/scripts/round_trips.py"
_spec = importlib.util.spec_from_file_location("round_trips", _SCRIPT)
assert _spec is not None and _spec.loader is not None
round_trips = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(round_trips)


def _db(path: Path) -> Path:
    con = sqlite3.connect(path)
    con.executescript(
        """
        create table chat_sessions (id text primary key, parent_session_id text, agent_name text);
        create table session_messages (id text primary key, session_id text, role text, kind text default 'chat',
          content text, tool_calls json, tool_call_id text, extra json, created_at datetime, seq integer);
        """
    )
    con.execute("insert into chat_sessions values ('lead', null, null)")
    con.execute("insert into chat_sessions values ('sub', 'lead', 'explorer#2')")
    seq = 0

    def add(session: str, role: str, content: str = "", calls: list | None = None, call_id: str | None = None, cost: float = 0.0):
        nonlocal seq
        seq += 1
        extra = json.dumps({"usage": {"input": 1000, "cost": {"estimated_usd": cost}}}) if role == "assistant" else None
        con.execute(
            "insert into session_messages values (?, ?, ?, 'chat', ?, ?, ?, ?, datetime('now', '-1 hour'), ?)",
            (f"m{seq}", session, role, content, json.dumps(calls) if calls else None, call_id, extra, seq),
        )

    def read(session: str, n: int, args: dict, cost: float):
        call = {"id": f"c{session}{n}", "function": {"name": "read", "arguments": json.dumps(args)}}
        add(session, "assistant", calls=[call], cost=cost)
        add(session, "tool", content="[1-10/10]\nx", call_id=call["id"])

    add("lead", "user", "look around")
    for n in range(5):  # five whole-file reads in a row by the main agent
        read("lead", n, {"path": f"f{n}.rs"}, 0.1)
    add("lead", "assistant", "done")
    add("sub", "user", "map it")
    for n in range(2):  # two windowed reads by an explorer
        read("sub", n, {"path": "g.rs", "offset": 1 + 10 * n, "limit": 10}, 0.01)
    con.commit()
    con.close()
    return path


def test_a_subagent_is_counted_under_its_profile():
    assert round_trips.role_of(None, None) == "main agent"
    assert round_trips.role_of("lead", "explorer#12") == "explorer"
    assert round_trips.role_of("lead", "") == "subagent"


def test_the_role_table_splits_cost_rows_and_whole_file_reads(tmp_path):
    db = _db(tmp_path / "a.db")
    out = subprocess.run([sys.executable, str(_SCRIPT), "--db", str(db), "--days", "1"], capture_output=True, text=True, check=True).stdout
    rows = {line.split()[0] + (" " + line.split()[1] if line.split()[0] == "main" else ""): line.split() for line in out.split("--- By role")[1].splitlines() if line.startswith("  main") or line.startswith("  explorer")}
    main, explorer = rows["main agent"], rows["explorer"]
    # role, steps, lookup %, $/lookup, $ lookup, $ all, in 5+ row, $ 5+ row, reads, whole %
    assert main[2:] == ["5", "100%", "0.100", "0", "0", "5", "0", "5", "100%"]
    assert explorer[1:] == ["2", "100%", "0.010", "0", "0", "0", "0", "2", "0%"]

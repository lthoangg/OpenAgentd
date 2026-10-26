#!/usr/bin/env python3
"""Reopen-lag and idle-CPU benchmark against one `openagentd` server binary.

    reopen.py <binary> <seeded-db> <label> <older-pages> [runs]

Starts the server on a throw-away root (copy of the seeded DB), then replays
what the web client requests when it opens the session: the newest history
page, then older pages until one holds a user prompt, at most <older-pages>
(10 at fad35386, 2 at HEAD in reader mode). Repeats `runs` times and prints
BENCH lines. A second fresh server sits idle for 60 s to measure CPU time.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import gzip
import urllib.parse
import urllib.request

binary, seeded_db, label, older_pages = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
runs = int(sys.argv[5]) if len(sys.argv) > 5 else 7


def seeded_lead(db):
    """API id (hyphenated) of the seeded lead session."""
    with sqlite3.connect(db) as c:
        (hex_id,) = c.execute("SELECT id FROM chat_sessions WHERE parent_session_id IS NULL LIMIT 1").fetchone()
    h = hex_id.replace("-", "")
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def start(root):
    env = {k: v for k, v in os.environ.items() if k not in ("OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_HANDSHAKE_FILE")}
    for k, d in [("OPENAGENTD_DATA_DIR", "data"), ("OPENAGENTD_CONFIG_DIR", "config"), ("OPENAGENTD_STATE_DIR", "state"), ("OPENAGENTD_CACHE_DIR", "cache"), ("HOME", "home")]:
        os.makedirs(os.path.join(root, d), exist_ok=True)
        env[k] = os.path.join(root, d)
    env.update(OPENAGENTD_ENV="production", OPENAGENTD_MODEL_REGISTRY_REFRESH="false", SNAPSHOT_MAINTENANCE_ENABLED="false")
    p = subprocess.Popen([binary, "server", "serve", "--host", "127.0.0.1", "--port", "0", "--handshake"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    assert p.stdout is not None
    line = p.stdout.readline()
    port = json.loads(line.split(" ", 1)[1])["port"]
    return p, f"http://127.0.0.1:{port}"


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p.kill()


# OAD_PERF_GZIP=1 asks for gzip like a browser does; reported bytes are
# then the compressed size on the wire.
GZIP = os.environ.get("OAD_PERF_GZIP") == "1"


def get(url):
    """(milliseconds, decoded body, bytes on the wire)."""
    t = time.perf_counter()
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"} if GZIP else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        encoded = r.headers.get("Content-Encoding") == "gzip"
    ms = (time.perf_counter() - t) * 1e3
    return ms, gzip.decompress(raw) if encoded else raw, len(raw)


def is_prompt(m):
    extra = m.get("extra") or {}
    return m.get("role") == "user" and extra.get("from_agent") in (None, "user")


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2]


def reopen(base, lead):
    ms, body, wire = get(f"{base}/api/agent/{lead}/history")
    page = json.loads(body)
    reqs, total_ms, total_bytes = 1, ms, wire
    member_ids = [m["id"] for mem in page.get("members", []) for m in mem.get("messages", [])]
    lead_rows = len(page["lead"]["messages"])
    found = any(is_prompt(m) for m in page["lead"]["messages"])
    cursor = page.get("next_cursor") if page.get("has_more") else None
    pages = 0
    while cursor and not found and pages < older_pages:
        ms, body, wire = get(f"{base}/api/agent/{lead}/history?before={urllib.parse.quote(cursor)}")
        page = json.loads(body)
        reqs, total_ms, total_bytes, pages = reqs + 1, total_ms + ms, total_bytes + wire, pages + 1
        member_ids += [m["id"] for mem in page.get("members", []) for m in mem.get("messages", [])]
        lead_rows += len(page["lead"]["messages"])
        found = any(is_prompt(m) for m in page["lead"]["messages"])
        cursor = page.get("next_cursor") if page.get("has_more") else None
    return reqs, total_ms, total_bytes, lead_rows, len(member_ids), len(member_ids) - len(set(member_ids))


root = tempfile.mkdtemp(prefix="oadperf-")
try:
    os.makedirs(os.path.join(root, "data"), exist_ok=True)
    shutil.copy(seeded_db, os.path.join(root, "data", "openagentd.db"))
    p, base = start(root)
    try:
        lead = os.environ.get("OAD_LEAD") or seeded_lead(seeded_db)
        reopen(base, lead)  # warm-up: starts the agent session, fills caches
        results = [reopen(base, lead) for _ in range(runs)]
    finally:
        stop(p)
    reqs, _, total_bytes, lead_rows, member_rows, dup = results[0]
    print(f"BENCH [{label}] reopen_requests value={reqs}")
    print(f"BENCH [{label}] reopen_total_ms median_ms={median([r[1] for r in results]):.1f} min_ms={min(r[1] for r in results):.1f} runs={runs}")
    print(f"BENCH [{label}] reopen_bytes value={total_bytes}")
    print(f"BENCH [{label}] reopen_rows lead={lead_rows} member={member_rows} member_duplicates={dup}")
finally:
    shutil.rmtree(root, ignore_errors=True)

idle_root = tempfile.mkdtemp(prefix="oadperf-idle-")
try:
    p, _ = start(idle_root)
    try:
        time.sleep(5)  # let startup work finish
        def cpu_s():
            out = subprocess.run(["ps", "-o", "cputime=", "-p", str(p.pid)], capture_output=True, text=True).stdout.strip()
            parts = [float(x) for x in out.replace("-", ":").split(":")]
            secs = 0.0
            for part in parts:
                secs = secs * 60 + part
            return secs
        c0 = cpu_s()
        time.sleep(60)
        print(f"BENCH [{label}] idle_cpu_60s value_ms={(cpu_s() - c0) * 1e3:.0f}")
    finally:
        stop(p)
finally:
    shutil.rmtree(idle_root, ignore_errors=True)

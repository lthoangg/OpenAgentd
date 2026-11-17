"""Check, sign and bundle the connector gallery list.

    python3 scripts/gallery.py check            validate every entry and test-connect each address
    python3 scripts/gallery.py sign --key PEM   write account-pages/connectors/v1.json.sig
    python3 scripts/gallery.py bundle           copy the list into the app as its offline copy

The list is published at https://account.openagentd.dev/connectors/v1.json
with its signature beside it (see account-pages/README.md). The app accepts
only a list signed by the key whose public half is DEFAULT_PUBLIC_KEY in
appv3/crates/api/src/gallery.rs.
"""

from __future__ import annotations

import argparse
import http.client
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LIST = ROOT / "account-pages" / "connectors" / "v1.json"
BUNDLED = ROOT / "appv3" / "crates" / "api" / "data" / "gallery.json"
ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
INIT = json.dumps(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "gallery-check", "version": "1"}},
    }
).encode()


def _https(url: object) -> bool:
    if not isinstance(url, str):
        return False
    u = urllib.parse.urlsplit(url)
    return u.scheme == "https" and bool(u.hostname) and not u.username and not u.password


def validate(doc: Any) -> list[str]:
    """Problems with a gallery document, as lines; empty when it is valid."""
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("entries"), list):
        return ['the list must be {"version": 1, "entries": [...]}']
    problems: list[str] = []
    seen: set[str] = set()
    entries: list[Any] = doc["entries"]
    for i, e in enumerate(entries):
        where = f"entry {i} ({e.get('id', '?') if isinstance(e, dict) else '?'})"
        if not isinstance(e, dict):
            problems.append(f"{where}: not an object")
            continue
        if e.get("type") == "plugin":
            continue
        if e.get("type") != "connector":
            problems.append(f"{where}: type must be connector or plugin")
            continue
        eid = e.get("id")
        if not isinstance(eid, str) or not ID_RE.match(eid):
            problems.append(f"{where}: id must be lowercase letters, digits and -, at most 40")
        elif eid in seen:
            problems.append(f"{where}: id is used twice")
        else:
            seen.add(eid)
        for field, limit in (("name", 60), ("description", 300)):
            v = e.get(field)
            if not isinstance(v, str) or not v.strip() or len(v) > limit:
                problems.append(f"{where}: {field} is required, at most {limit} characters")
        if not _https(e.get("url")):
            problems.append(f"{where}: url must be https")
        for u in e.get("previous_urls", []):
            if not _https(u):
                problems.append(f"{where}: previous_urls must be https")
        auth = e.get("auth")
        if isinstance(auth, dict):
            if not isinstance(auth.get("header"), str) or not HEADER_RE.match(auth["header"]):
                problems.append(f"{where}: auth.header must be a header name")
            if not isinstance(auth.get("template"), str) or "{key}" not in auth["template"]:
                problems.append(f"{where}: auth.template must contain {{key}}")
            if "key_url" in auth and not _https(auth["key_url"]):
                problems.append(f"{where}: auth.key_url must be https")
        elif auth not in ("none", "oauth"):
            problems.append(f"{where}: auth must be none, oauth or a key object")
    return problems


def _get_json(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "openagentd-gallery-check/1"}), timeout=10) as r:
            v = json.load(r)
            return v if isinstance(v, dict) else None
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None


def _initialize_status(url: str) -> int:
    """The status an MCP `initialize` gets. Only the status line is read: a
    server that answers with an event stream may keep it open."""
    u = urllib.parse.urlsplit(url)
    conn = http.client.HTTPSConnection(u.hostname or "", u.port or 443, timeout=15)
    try:
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream", "user-agent": "openagentd-gallery-check/1"}
        conn.request("POST", (u.path or "/") + (f"?{u.query}" if u.query else ""), body=INIT, headers=headers)
        return conn.getresponse().status
    finally:
        if conn.sock:
            conn.sock.close()


def probe(entry: dict) -> tuple[bool, str]:
    """Whether the entry's address behaves as its auth says."""
    try:
        status = _initialize_status(entry["url"])
    except (OSError, http.client.HTTPException) as e:
        return False, f"unreachable: {e}"
    auth = entry["auth"]
    if auth == "none":
        return status == 200, f"initialize answered {status}"
    if isinstance(auth, dict):
        return status in (200, 401, 403), f"answered {status} without a key"
    if status != 401:
        return False, f"expected a sign-in request (401), got {status}"
    u = urllib.parse.urlsplit(entry["url"])
    origin, path = f"{u.scheme}://{u.netloc}", u.path.rstrip("/")
    prm = _get_json(f"{origin}/.well-known/oauth-protected-resource{path}") or _get_json(f"{origin}/.well-known/oauth-protected-resource") or {}
    issuer = (prm.get("authorization_servers") or [origin])[0]
    a = urllib.parse.urlsplit(issuer)
    ap = a.path.rstrip("/")
    base = f"{a.scheme}://{a.netloc}"
    meta = (
        _get_json(f"{base}/.well-known/oauth-authorization-server{ap}")
        or _get_json(f"{base}/.well-known/openid-configuration{ap}")
        or _get_json(f"{base}{ap}/.well-known/openid-configuration")
        or {}
    )
    if meta.get("registration_endpoint"):
        return True, "signs in with automatic registration"
    return False, "no automatic client registration found"


def cmd_check(_args: argparse.Namespace) -> int:
    doc = json.loads(LIST.read_text())
    problems = validate(doc)
    for p in problems:
        print(f"✗ {p}")
    connectors = [e for e in doc.get("entries", []) if isinstance(e, dict) and e.get("type") == "connector"]
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(probe, connectors))
    failed = 0
    for e, (ok, why) in zip(connectors, results):
        failed += not ok
        print(f"{'✓' if ok else '✗'} {e['id']:<18} {why}")
    return 1 if problems or failed else 0


def sign(body: bytes, key: Path) -> str:
    """Base64 Ed25519 signature over `body` with the PEM private key `key`."""
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d) / "body", Path(d) / "sig"
        src.write_bytes(body)
        subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(src), "-out", str(out)], check=True)
        return base64.b64encode(out.read_bytes()).decode()


def cmd_sign(args: argparse.Namespace) -> int:
    body = LIST.read_bytes()
    problems = validate(json.loads(body))
    if problems:
        print("\n".join(f"✗ {p}" for p in problems))
        return 1
    sig = sign(body, Path(args.key).expanduser())
    LIST.with_name("v1.json.sig").write_text(sig + "\n")
    print(f"signed {LIST.relative_to(ROOT)}")
    return 0


def cmd_bundle(_args: argparse.Namespace) -> int:
    shutil.copyfile(LIST, BUNDLED)
    print(f"copied to {BUNDLED.relative_to(ROOT)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").set_defaults(func=cmd_check)
    s = sub.add_parser("sign")
    s.add_argument("--key", required=True, help="the gallery signing key (PEM, Ed25519)")
    s.set_defaults(func=cmd_sign)
    sub.add_parser("bundle").set_defaults(func=cmd_bundle)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

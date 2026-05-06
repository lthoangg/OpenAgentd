#!/usr/bin/env python3
"""mcp_apply.py — MCP server management script for openagentd agents.

Wraps the /api/mcp/* endpoints so agents can manage MCP servers with a
single shell call instead of constructing curl commands manually.

When the daemon is unreachable, add/update/remove/apply fall back to
editing mcp.json directly and exit 0 — the agent can then proceed to
wiring without any manual intervention.

Usage:
  python mcp_apply.py apply
  python mcp_apply.py add <name> --http <url>
  python mcp_apply.py add <name> --stdio <command> [--args arg1 arg2 ...] [--env K=V ...]
  python mcp_apply.py update <name> --http <url>
  python mcp_apply.py update <name> --stdio <command> [--args arg1 arg2 ...] [--env K=V ...]
  python mcp_apply.py remove <name>
  python mcp_apply.py restart <name>
  python mcp_apply.py status [<name>]
  python mcp_apply.py wait <name> [--timeout 30]

Exit codes:
  0  success (or daemon unreachable but mcp.json updated as fallback)
  1  API / validation error (detail printed to stderr)
  2  server ended up in errored state
  3  wait timed out (server still starting)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE = "http://localhost:4082/api/mcp"
DEFAULT_MCP_JSON = Path(
    os.environ.get("OPENAGENTD_CONFIG_DIR", Path.home() / ".openagentd" / "config")
) / "mcp.json"


# ── HTTP helpers ─────────────────────────────────────────────────────────────


class DaemonUnreachable(Exception):
    pass


def _request(
    method: str,
    url: str,
    body: dict | None = None,
) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"detail": raw.decode(errors="replace")}
        return exc.code, payload
    except (OSError, urllib.error.URLError) as exc:
        raise DaemonUnreachable(str(exc)) from exc


def _ok(status: int, payload: Any, *, allow_404: bool = False) -> Any:
    if status in (200, 201):
        return payload
    if allow_404 and status == 404:
        return None
    detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
    print(f"error {status}: {detail}", file=sys.stderr)
    sys.exit(1)


# ── mcp.json fallback ────────────────────────────────────────────────────────


def _load_mcp_json(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"servers": {}}


def _save_mcp_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def _server_body_to_config(body: dict) -> dict:
    """Convert API server body to mcp.json config shape."""
    if body["transport"] == "http":
        return {"transport": "http", "url": body["url"], "headers": body.get("headers", {}), "enabled": body.get("enabled", True)}
    return {
        "transport": "stdio",
        "command": body["command"],
        "args": body.get("args", []),
        "env": body.get("env", {}),
        "enabled": body.get("enabled", True),
    }


def _fallback_add(name: str, server_body: dict, mcp_json: Path) -> None:
    data = _load_mcp_json(mcp_json)
    data.setdefault("servers", {})[name] = _server_body_to_config(server_body)
    _save_mcp_json(mcp_json, data)
    print(f"daemon unreachable — wrote {name} to {mcp_json} (takes effect on next daemon restart)")


def _fallback_update(name: str, server_body: dict, mcp_json: Path) -> None:
    data = _load_mcp_json(mcp_json)
    data.setdefault("servers", {})[name] = _server_body_to_config(server_body)
    _save_mcp_json(mcp_json, data)
    print(f"daemon unreachable — updated {name} in {mcp_json} (takes effect on next daemon restart)")


def _fallback_remove(name: str, mcp_json: Path) -> None:
    data = _load_mcp_json(mcp_json)
    data.setdefault("servers", {}).pop(name, None)
    _save_mcp_json(mcp_json, data)
    print(f"daemon unreachable — removed {name} from {mcp_json} (takes effect on next daemon restart)")


def _fallback_apply(mcp_json: Path) -> None:
    # Nothing to do — mcp.json is already the source of truth.
    print(f"daemon unreachable — {mcp_json} is already up to date (takes effect on next daemon restart)")


# ── Commands ─────────────────────────────────────────────────────────────────


def cmd_apply(base: str, mcp_json: Path) -> None:
    """Re-read mcp.json and reconcile every runner."""
    try:
        status, payload = _request("POST", f"{base}/apply")
    except DaemonUnreachable:
        _fallback_apply(mcp_json)
        return
    result = _ok(status, payload)
    servers = result.get("servers", [])
    errored = [s for s in servers if s["state"] == "errored"]
    for s in servers:
        state = s["state"]
        tools = len(s.get("tool_names") or [])
        err = f"  error: {s['error']}" if s.get("error") else ""
        print(f"  {s['name']:20s}  {state:10s}  tools={tools}{err}")
    if errored:
        sys.exit(2)


def cmd_add(base: str, name: str, server_body: dict, mcp_json: Path) -> None:
    """Add a new MCP server and start it."""
    try:
        status, payload = _request("POST", f"{base}/servers", {"name": name, "server": server_body})
    except DaemonUnreachable:
        _fallback_add(name, server_body, mcp_json)
        return
    result = _ok(status, payload)
    _print_server(result)
    if result.get("state") == "errored":
        sys.exit(2)


def cmd_update(base: str, name: str, server_body: dict, mcp_json: Path) -> None:
    """Update an existing MCP server config and restart it."""
    try:
        status, payload = _request("PUT", f"{base}/servers/{name}", {"server": server_body})
    except DaemonUnreachable:
        _fallback_update(name, server_body, mcp_json)
        return
    result = _ok(status, payload)
    _print_server(result)
    if result.get("state") == "errored":
        sys.exit(2)


def cmd_remove(base: str, name: str, mcp_json: Path) -> None:
    """Remove an MCP server and stop its runner."""
    try:
        status, payload = _request("DELETE", f"{base}/servers/{name}")
    except DaemonUnreachable:
        _fallback_remove(name, mcp_json)
        return
    _ok(status, payload)
    print(f"removed: {name}")


def cmd_restart(base: str, name: str) -> None:
    """Restart an MCP server runner without touching mcp.json."""
    try:
        status, payload = _request("POST", f"{base}/servers/{name}/restart")
    except DaemonUnreachable as exc:
        print(f"error: daemon unreachable — cannot restart runner: {exc}", file=sys.stderr)
        sys.exit(1)
    result = _ok(status, payload)
    _print_server(result)
    if result.get("state") == "errored":
        sys.exit(2)


def cmd_status(base: str, name: str | None) -> None:
    """Show state of one or all MCP servers."""
    try:
        if name:
            status, payload = _request("GET", f"{base}/servers/{name}")
            result = _ok(status, payload)
            _print_server(result, verbose=True)
        else:
            status, payload = _request("GET", f"{base}/servers")
            result = _ok(status, payload)
            for s in result.get("servers", []):
                _print_server(s)
    except DaemonUnreachable as exc:
        print(f"error: daemon unreachable: {exc}", file=sys.stderr)
        sys.exit(1)


def cmd_wait(base: str, name: str, timeout: int) -> None:
    """Poll until server is ready or errored, or timeout expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, payload = _request("GET", f"{base}/servers/{name}")
        except DaemonUnreachable as exc:
            print(f"error: daemon unreachable: {exc}", file=sys.stderr)
            sys.exit(1)
        result = _ok(status, payload, allow_404=True)
        if result is None:
            print(f"error: server '{name}' not found", file=sys.stderr)
            sys.exit(1)
        state = result.get("state")
        if state == "ready":
            _print_server(result, verbose=True)
            return
        if state == "errored":
            _print_server(result, verbose=True)
            sys.exit(2)
        time.sleep(1)
    print(f"error: timed out waiting for '{name}' to become ready", file=sys.stderr)
    sys.exit(3)


# ── Formatting ───────────────────────────────────────────────────────────────


def _print_server(s: dict, *, verbose: bool = False) -> None:
    state = s.get("state", "?")
    tools = s.get("tool_names") or []
    err = s.get("error")
    print(f"{s['name']:20s}  {state:10s}  tools={len(tools)}")
    if verbose:
        for t in tools:
            print(f"  - {t}")
    if err:
        print(f"  error: {err}", file=sys.stderr)


# ── Argument parsing ─────────────────────────────────────────────────────────


def _server_body_args(p: argparse.ArgumentParser) -> None:
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--http", metavar="URL", help="HTTP/SSE transport URL")
    group.add_argument("--stdio", metavar="CMD", help="stdio transport command")
    p.add_argument("--args", nargs="*", default=[], metavar="ARG", help="args for --stdio")
    p.add_argument(
        "--env", nargs="*", default=[], metavar="K=V", help="env vars for --stdio (KEY=VALUE)"
    )


def _parse_server_body(args: argparse.Namespace) -> dict:
    if args.http:
        return {"transport": "http", "url": args.http}
    env = {}
    for kv in (args.env or []):
        k, _, v = kv.partition("=")
        env[k] = v
    return {"transport": "stdio", "command": args.stdio, "args": args.args or [], "env": env}


def main() -> None:
    p = argparse.ArgumentParser(
        description="Manage openagentd MCP servers via the daemon API."
    )
    p.add_argument("--base", default=DEFAULT_BASE, help=f"API base URL (default: {DEFAULT_BASE})")
    p.add_argument("--mcp-json", default=str(DEFAULT_MCP_JSON), help="Path to mcp.json for fallback writes")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("apply", help="Re-read mcp.json and reconcile all runners")

    add_p = sub.add_parser("add", help="Add a new MCP server")
    add_p.add_argument("name")
    _server_body_args(add_p)

    upd_p = sub.add_parser("update", help="Update an existing MCP server")
    upd_p.add_argument("name")
    _server_body_args(upd_p)

    rm_p = sub.add_parser("remove", help="Remove an MCP server")
    rm_p.add_argument("name")

    rst_p = sub.add_parser("restart", help="Restart an MCP server runner")
    rst_p.add_argument("name")

    st_p = sub.add_parser("status", help="Show server state")
    st_p.add_argument("name", nargs="?", default=None)

    wt_p = sub.add_parser("wait", help="Poll until server is ready")
    wt_p.add_argument("name")
    wt_p.add_argument("--timeout", type=int, default=30, metavar="SEC")

    args = p.parse_args()
    base = args.base.rstrip("/")
    mcp_json = Path(args.mcp_json)

    if args.cmd == "apply":
        cmd_apply(base, mcp_json)
    elif args.cmd == "add":
        cmd_add(base, args.name, _parse_server_body(args), mcp_json)
    elif args.cmd == "update":
        cmd_update(base, args.name, _parse_server_body(args), mcp_json)
    elif args.cmd == "remove":
        cmd_remove(base, args.name, mcp_json)
    elif args.cmd == "restart":
        cmd_restart(base, args.name)
    elif args.cmd == "status":
        cmd_status(base, args.name)
    elif args.cmd == "wait":
        cmd_wait(base, args.name, args.timeout)


if __name__ == "__main__":
    main()

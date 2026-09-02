"""Smoke-test team session resolve-or-create flows.

Tests: POST /agent/sessions/resolve, GET /agent/sessions/{id}.

Usage:
  uv run python -m manual.session_resolve
  uv run python -m manual.session_resolve --workspace /path/to/repo
  uv run python -m manual.session_resolve --keep-workspace
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from uuid import UUID

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


def resolve_session(base: str, payload: dict) -> dict:
    r = httpx.post(f"{base}/agent/sessions/resolve", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def get_session(base: str, session_id: str) -> dict:
    r = httpx.get(f"{base}/agent/sessions/{session_id}", timeout=30)
    r.raise_for_status()
    return r.json()


def assert_uuid(value: str) -> None:
    UUID(value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve/create team sessions")
    parser.add_argument("--base", default=BASE, help="API base URL")
    parser.add_argument(
        "--workspace",
        default=None,
        help="Workspace path for coding resolve. Defaults to a temp directory.",
    )
    parser.add_argument(
        "--keep-workspace",
        action="store_true",
        help="Do not delete the temporary workspace after the smoke test.",
    )
    args = parser.parse_args()

    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    if args.workspace:
        workspace = Path(args.workspace).expanduser().resolve()
        workspace.mkdir(parents=True, exist_ok=True)
    else:
        temp_dir = tempfile.TemporaryDirectory(prefix="openagentd-session-resolve-")
        workspace = Path(temp_dir.name).resolve()

    try:
        sess = resolve_session(
            args.base,
            {"workspace": str(workspace)},
        )
        assert_uuid(sess["id"])
        if sess.get("workspace") != str(workspace):
            raise AssertionError(
                f"workspace mismatch: expected {workspace}, got {sess.get('workspace')}"
            )
        sess_detail = get_session(args.base, sess["id"])
        if sess_detail["id"] != sess["id"]:
            raise AssertionError("session detail id mismatch")

        sess_again = resolve_session(
            args.base,
            {"workspace": str(workspace)},
        )
        if sess_again["id"] != sess["id"]:
            raise AssertionError(
                "second resolve should reuse latest empty session: "
                f"{sess['id']} != {sess_again['id']}"
            )
        if sess_again.get("created") is not False:
            raise AssertionError(f"second resolve should not create: {sess_again}")

        sess_new = resolve_session(
            args.base,
            {"workspace": str(workspace), "create": True},
        )
        if sess_new["id"] == sess["id"]:
            raise AssertionError("forced create should allocate a fresh session")
        if sess_new.get("created") is not True:
            raise AssertionError(f"forced create should report created: {sess_new}")

        print("session_resolve: ok")
        print(f"session: {sess['id']} workspace={sess['workspace']}")
        print(f"session_new: {sess_new['id']} forced_create=True")
    finally:
        if temp_dir is not None and not args.keep_workspace:
            temp_dir.cleanup()


if __name__ == "__main__":
    main()

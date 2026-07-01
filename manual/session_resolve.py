"""Smoke-test team session resolve-or-create flows.

Tests: POST /team/sessions/resolve, GET /team/sessions/{id}.

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
    r = httpx.post(f"{base}/team/sessions/resolve", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def get_session(base: str, session_id: str) -> dict:
    r = httpx.get(f"{base}/team/sessions/{session_id}", timeout=30)
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
        normal = resolve_session(args.base, {"mode": "normal"})
        assert_uuid(normal["id"])
        if normal["mode"] != "normal":
            raise AssertionError(f"expected normal mode, got {normal['mode']!r}")
        if normal.get("workspace") is not None:
            raise AssertionError(f"normal session should not have workspace: {normal}")
        normal_detail = get_session(args.base, normal["id"])
        if normal_detail["id"] != normal["id"]:
            raise AssertionError("normal detail id mismatch")

        coding = resolve_session(
            args.base,
            {"mode": "coding", "workspace": str(workspace)},
        )
        assert_uuid(coding["id"])
        if coding["mode"] != "coding":
            raise AssertionError(f"expected coding mode, got {coding['mode']!r}")
        if coding.get("workspace") != str(workspace):
            raise AssertionError(
                f"coding workspace mismatch: expected {workspace}, got {coding.get('workspace')}"
            )

        coding_again = resolve_session(
            args.base,
            {"mode": "coding", "workspace": str(workspace)},
        )
        if coding_again["id"] != coding["id"]:
            raise AssertionError(
                "second coding resolve should reuse latest empty session: "
                f"{coding['id']} != {coding_again['id']}"
            )
        if coding_again.get("created") is not False:
            raise AssertionError(f"second coding resolve should not create: {coding_again}")

        coding_new = resolve_session(
            args.base,
            {"mode": "coding", "workspace": str(workspace), "create": True},
        )
        if coding_new["id"] == coding["id"]:
            raise AssertionError("forced coding create should allocate a fresh session")
        if coding_new.get("created") is not True:
            raise AssertionError(f"forced coding create should report created: {coding_new}")

        print("session_resolve: ok")
        print(f"normal: {normal['id']} created={normal.get('created')}")
        print(f"coding: {coding['id']} workspace={coding['workspace']}")
        print(f"coding_new: {coding_new['id']} forced_create=True")
    finally:
        if temp_dir is not None and not args.keep_workspace:
            temp_dir.cleanup()


if __name__ == "__main__":
    main()

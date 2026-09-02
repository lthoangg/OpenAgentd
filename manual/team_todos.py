"""Print and check todos for an agent session.

Usage:
  uv run python -m manual.team_todos SESSION_ID
"""

from __future__ import annotations

import argparse
from typing import Any

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


def fetch_todos(base: str, session_id: str) -> list[dict[str, Any]]:
    r = httpx.get(f"{base}/agent/sessions/{session_id}/todos")
    r.raise_for_status()
    data = r.json()
    todos = data.get("todos", [])
    return [todo for todo in todos if isinstance(todo, dict)]


def print_todos(todos: list[dict[str, Any]]) -> None:
    print(f"\ntodos (count={len(todos)}):")
    print("-" * 80)
    print(f"{'task':10s}  {'status':14s}  content")
    print("-" * 80)
    for todo in todos:
        print(
            f"{str(todo.get('task_id', '-')):10s}  "
            f"{str(todo.get('status', '-')):14s}  "
            f"{todo.get('content') or ''}"
        )


def main() -> None:
    p = argparse.ArgumentParser(description="Print session todos")
    p.add_argument("session_id", help="Session ID")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()

    todos = fetch_todos(args.base.rstrip("/"), args.session_id)
    print_todos(todos)


if __name__ == "__main__":
    main()

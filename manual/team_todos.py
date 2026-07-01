"""Print and check todos for a team session.

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
    r = httpx.get(f"{base}/team/sessions/{session_id}/todos")
    r.raise_for_status()
    data = r.json()
    todos = data.get("todos", [])
    return [todo for todo in todos if isinstance(todo, dict)]


def print_todos(todos: list[dict[str, Any]]) -> None:
    print(f"\ntodos (count={len(todos)}):")
    print("-" * 110)
    print(
        f"{'task':8s}  {'status':11s}  {'priority':8s}  {'assigned':18s}  {'claimed':18s}  deps  content"
    )
    print("-" * 110)
    for todo in todos:
        dependencies = todo.get("dependencies") or []
        deps = ",".join(dependencies) if dependencies else "-"
        print(
            f"{str(todo.get('task_id', '-')):8s}  "
            f"{str(todo.get('status', '-')):11s}  "
            f"{str(todo.get('priority', '-')):8s}  "
            f"{str(todo.get('assigned_to') or '-'):18s}  "
            f"{str(todo.get('claimed_by') or '-'):18s}  "
            f"{deps:5s}  "
            f"{todo.get('content') or ''}"
        )


def find_issues(todos: list[dict[str, Any]]) -> list[str]:
    by_id = {todo.get("task_id"): todo for todo in todos}
    completed = {
        todo.get("task_id") for todo in todos if todo.get("status") == "completed"
    }
    issues: list[str] = []

    for todo in todos:
        task_id = str(todo.get("task_id") or "?")
        assigned_to = todo.get("assigned_to")
        claimed_by = todo.get("claimed_by")
        dependencies = todo.get("dependencies") or []

        for dependency in dependencies:
            if dependency not in by_id:
                issues.append(f"{task_id}: unknown dependency {dependency}")
            elif dependency not in completed and todo.get("status") == "in_progress":
                issues.append(f"{task_id}: in progress while blocked by {dependency}")

        if todo.get("status") == "in_progress" and not claimed_by:
            issues.append(f"{task_id}: in progress without claimed_by")

        if isinstance(assigned_to, str) and any(sep in assigned_to for sep in ["/", ","]):
            issues.append(
                f"{task_id}: assigned_to={assigned_to!r} is not a single claimable handle"
            )
        elif isinstance(assigned_to, str) and "#" not in assigned_to:
            issues.append(
                f"{task_id}: assigned_to={assigned_to!r} is not a concrete instance handle"
            )

        if assigned_to and claimed_by and assigned_to != claimed_by:
            issues.append(
                f"{task_id}: assigned_to={assigned_to!r} but claimed_by={claimed_by!r}"
            )

    return issues


def print_issues(issues: list[str]) -> None:
    print("\nconsistency checks:")
    print("-" * 110)
    if not issues:
        print("  ok")
        return
    for issue in issues:
        print(f"  ! {issue}")


def main() -> None:
    p = argparse.ArgumentParser(description="Print and check team session todos")
    p.add_argument("session_id", help="Team session ID")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()

    todos = fetch_todos(args.base.rstrip("/"), args.session_id)
    print_todos(todos)
    print_issues(find_issues(todos))


if __name__ == "__main__":
    main()

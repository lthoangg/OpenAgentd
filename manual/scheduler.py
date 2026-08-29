"""Smoke-test the scheduler API.

Usage:
  uv run python -m manual.scheduler list
  uv run python -m manual.scheduler create --type every --every 60 --prompt "Say hello"
  uv run python -m manual.scheduler create --type cron --cron "*/5 * * * *" --prompt "Ping"
  uv run python -m manual.scheduler create --type at --at "2099-01-01T00:00:00Z" --prompt "Future"
  uv run python -m manual.scheduler trigger <TASK_ID>
  uv run python -m manual.scheduler pause   <TASK_ID>
  uv run python -m manual.scheduler resume  <TASK_ID>
  uv run python -m manual.scheduler delete  <TASK_ID>
  uv run python -m manual.scheduler demo    --agent <name>   # create + trigger + list + delete
  uv run python -m manual.scheduler finite-demo              # create max_runs=1 + verify completion + delete
"""

from __future__ import annotations

import argparse
import time
import uuid
from pathlib import Path

import httpx

from manual._common import DEFAULT_BASE

BASE = DEFAULT_BASE


# ── helpers ───────────────────────────────────────────────────────────────────


def _get(base: str, path: str) -> dict:
    r = httpx.get(f"{base}{path}")
    r.raise_for_status()
    return r.json()


def _post(base: str, path: str, body: dict | None = None) -> dict:
    r = httpx.post(f"{base}{path}", json=body)
    r.raise_for_status()
    return r.json()


def _delete(base: str, path: str) -> None:
    r = httpx.delete(f"{base}{path}")
    r.raise_for_status()


def _print_task(task: dict, *, indent: str = "") -> None:
    nf = task.get("next_fire_at") or "-"
    lr = task.get("last_run_at") or "-"
    err = task.get("last_error") or ""
    runs = f"{task['run_count']}"
    if task.get("max_runs"):
        runs += f"/{task['max_runs']}"
    print(
        f"{indent}[{task['status']:9}] {task['name']!r:30}"
        f"  type={task['schedule_type']}"
        f"  runs={runs}"
        f"  next={nf}"
    )
    if task.get("cron_expression"):
        print(
            f"{indent}           cron={task['cron_expression']}  tz={task['timezone']}"
        )
    elif task.get("every_seconds"):
        print(f"{indent}           every={task['every_seconds']}s")
    elif task.get("at_datetime"):
        print(f"{indent}           at={task['at_datetime']}")
    print(f"{indent}           prompt={task['prompt'][:80]!r}")
    if task.get("workspace"):
        print(f"{indent}           workspace={task['workspace']}")
    print(f"{indent}           last_run={lr}")
    if err:
        print(f"{indent}           error={err}")


# ── commands ──────────────────────────────────────────────────────────────────


def cmd_list(base: str) -> None:
    data = _get(base, "/scheduler/tasks")
    tasks = data.get("tasks", [])
    if not tasks:
        print("no scheduled tasks")
        return
    print(f"{len(tasks)} task(s):")
    for t in tasks:
        _print_task(t, indent="  ")
        print()


def cmd_create(base: str, args: argparse.Namespace) -> dict:
    body: dict = {
        "name": args.name,
        "schedule_type": args.type,
        "prompt": args.prompt,
        "timezone": args.timezone,
        "workspace": args.workspace or str(Path.cwd()),
    }
    if args.type == "at":
        body["at_datetime"] = args.at
    elif args.type == "every":
        body["every_seconds"] = int(args.every)
    elif args.type == "cron":
        body["cron_expression"] = args.cron
    if args.session:
        body["session_id"] = args.session
    if args.max_runs:
        body["max_runs"] = int(args.max_runs)

    task = _post(base, "/scheduler/tasks", body)
    print("created:")
    _print_task(task, indent="  ")
    return task


def cmd_trigger(base: str, task_id: str) -> None:
    result = _post(base, f"/scheduler/tasks/{task_id}/trigger")
    print(f"triggered: {result}")


def cmd_pause(base: str, task_id: str) -> None:
    task = _post(base, f"/scheduler/tasks/{task_id}/pause")
    print(f"paused: status={task['status']}")


def cmd_resume(base: str, task_id: str) -> None:
    task = _post(base, f"/scheduler/tasks/{task_id}/resume")
    print(f"resumed: status={task['status']}  next_fire_at={task.get('next_fire_at')}")


def cmd_delete(base: str, task_id: str) -> None:
    _delete(base, f"/scheduler/tasks/{task_id}")
    print(f"deleted {task_id}")


def cmd_demo(base: str, args: argparse.Namespace) -> None:
    """Create an 'every 999s' task, trigger it, wait 2s, list, then delete."""
    import uuid

    unique = uuid.uuid4().hex[:6]
    name = f"demo-{unique}"

    print(f"--- demo: creating task '{name}' ---")
    body = {
        "name": name,
        "schedule_type": "every",
        "every_seconds": 999,
        "prompt": "This is a scheduler demo. Reply with just: SCHEDULER_OK",
        "timezone": "UTC",
        "workspace": args.workspace or str(Path.cwd()),
    }
    task = _post(base, "/scheduler/tasks", body)
    task_id = task["id"]
    print(f"  created id={task_id}")

    print("--- triggering immediately ---")
    _post(base, f"/scheduler/tasks/{task_id}/trigger")
    print("  dispatched (agent is running in background)")

    print("--- waiting 3s for run_count to increment ---")
    time.sleep(3)

    print("--- listing tasks ---")
    cmd_list(base)

    print(f"--- deleting demo task {task_id} ---")
    _delete(base, f"/scheduler/tasks/{task_id}")
    print("  done")


def cmd_finite_demo(base: str, args: argparse.Namespace) -> None:
    """Create a max_runs=1 task, wait for completion, then delete it."""
    unique = uuid.uuid4().hex[:6]
    name = f"finite-demo-{unique}"

    print(f"--- finite demo: creating task '{name}' with max_runs=1 ---")
    body = {
        "name": name,
        "schedule_type": "every",
        "every_seconds": 1,
        "prompt": "This is a finite scheduler demo. Reply with just: FINITE_SCHEDULER_OK",
        "timezone": "UTC",
        "max_runs": 1,
        "workspace": args.workspace or str(Path.cwd()),
    }
    task = _post(base, "/scheduler/tasks", body)
    task_id = task["id"]
    _print_task(task, indent="  ")

    print("--- waiting for run_count=1 and status=completed ---")
    deadline = time.monotonic() + args.timeout
    final = task
    while time.monotonic() < deadline:
        final = _get(base, f"/scheduler/tasks/{task_id}")
        if (
            final.get("run_count") == 1
            and final.get("status") == "completed"
            and final.get("enabled") is False
            and final.get("next_fire_at") is None
        ):
            print("  verified finite task completed after one firing")
            _print_task(final, indent="  ")
            break
        time.sleep(0.5)
    else:
        print("  failed: finite task did not complete before timeout")
        _print_task(final, indent="  ")
        raise SystemExit(1)

    print(f"--- deleting finite demo task {task_id} ---")
    _delete(base, f"/scheduler/tasks/{task_id}")
    print("  done")


# ── entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description="Scheduler API smoke tests")
    p.add_argument("--base", default=BASE)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List all scheduled tasks")

    cr = sub.add_parser("create", help="Create a scheduled task")
    cr.add_argument(
        "--name", default=None, help="Task name (auto-generated if omitted)"
    )
    cr.add_argument(
        "--workspace", default=None, help="Workspace directory (defaults to cwd)"
    )
    cr.add_argument(
        "--type", choices=["at", "every", "cron"], required=True, dest="type"
    )
    cr.add_argument("--at", default=None, help="ISO-8601 datetime for 'at' type")
    cr.add_argument(
        "--every", default=None, help="Interval in seconds for 'every' type"
    )
    cr.add_argument("--cron", default=None, help="5-field cron expression")
    cr.add_argument("--timezone", default="UTC")
    cr.add_argument("--prompt", required=True, help="Prompt to send to the agent")
    cr.add_argument(
        "--session", default=None, help="session_id (omit=new, 'auto'=persistent)"
    )
    cr.add_argument("--max-runs", default=None, help="Positive cap on successful runs")

    tr = sub.add_parser("trigger", help="Fire a task immediately")
    tr.add_argument("task_id")

    pa = sub.add_parser("pause", help="Pause a task")
    pa.add_argument("task_id")

    re = sub.add_parser("resume", help="Resume a paused task")
    re.add_argument("task_id")

    de = sub.add_parser("delete", help="Delete a task")
    de.add_argument("task_id")

    dm = sub.add_parser(
        "demo", help="End-to-end demo: create + trigger + list + delete"
    )
    dm.add_argument(
        "--workspace", default=None, help="Workspace directory (defaults to cwd)"
    )

    fd = sub.add_parser(
        "finite-demo", help="End-to-end max_runs demo: create + wait + delete"
    )
    fd.add_argument(
        "--workspace", default=None, help="Workspace directory (defaults to cwd)"
    )
    fd.add_argument("--timeout", type=float, default=30.0)

    args = p.parse_args()
    base = args.base.rstrip("/")

    # auto-generate name for create
    if args.cmd == "create" and args.name is None:
        import uuid

        args.name = f"task-{uuid.uuid4().hex[:6]}"

    try:
        if args.cmd == "list":
            cmd_list(base)
        elif args.cmd == "create":
            cmd_create(base, args)
        elif args.cmd == "trigger":
            cmd_trigger(base, args.task_id)
        elif args.cmd == "pause":
            cmd_pause(base, args.task_id)
        elif args.cmd == "resume":
            cmd_resume(base, args.task_id)
        elif args.cmd == "delete":
            cmd_delete(base, args.task_id)
        elif args.cmd == "demo":
            cmd_demo(base, args)
        elif args.cmd == "finite-demo":
            cmd_finite_demo(base, args)
    except httpx.HTTPStatusError as e:
        print(f"HTTP {e.response.status_code}: {e.response.text}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()

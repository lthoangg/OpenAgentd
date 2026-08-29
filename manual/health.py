"""Health check + team agents info.

Usage: uv run python -m manual.health [--base URL]
"""

import argparse
import httpx

from manual._common import DEFAULT_BASE, require_dev_server

BASE = DEFAULT_BASE


def main():
    p = argparse.ArgumentParser(description="Health + agents check")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")
    require_dev_server(base)

    # Health endpoint — the legacy ``/api/health`` alias was removed; use
    # the readiness probe so a "healthy" report covers DB + team too.
    r = httpx.get(f"{base}/health/ready")
    r.raise_for_status()
    print(f"health: {r.json()}")

    # Coding agent
    r = httpx.get(f"{base}/agent/agents")
    r.raise_for_status()
    data = r.json()
    print("\ncoding agent:")
    for a in data["agents"]:
        caps = a.get("capabilities", {})
        vision = caps.get("input", {}).get("vision", False)
        tools = [t["name"] for t in a.get("tools", [])]
        skills = [s["name"] for s in a.get("skills", [])]
        print(f"  {a['name']:15s} {a['model']}")
        if tools:
            print(f"    tools:  {', '.join(tools)}")
        if skills:
            print(f"    skills: {', '.join(skills)}")
        if vision:
            print(f"    vision: {vision}")


if __name__ == "__main__":
    main()

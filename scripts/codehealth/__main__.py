"""Code-health analyzer CLI.

Ranks "god files" and maps intra-project import dependencies across the
Python backend and the TS/React frontend, and detects circular imports.

Examples
--------
    # Top god files across the whole repo (text report)
    uv run python -m scripts.codehealth

    # Backend only, JSON for tooling/baselines
    uv run python -m scripts.codehealth --lang python --json > health.json

    # CI gate: fail if any file scores above a budget, or cycles exist
    uv run python -m scripts.codehealth --max-score 800 --fail-on-cycles
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from scripts.codehealth.model import FileReport
from scripts.codehealth.py_analyzer import analyze_python_file, collect_python_files
from scripts.codehealth.scoring import compute_fan, find_cycles, score_report
from scripts.codehealth.ts_analyzer import analyze_ts_file, collect_ts_files

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_ROOTS = ["app"]
TS_SRC = "web/src"


def _build_python_module_index(reports: dict[str, FileReport]) -> dict[str, str]:
    """Map dotted module keys -> file path so imports resolve to analyzed files."""
    index: dict[str, str] = {}
    for path in reports:
        if not path.endswith(".py"):
            continue
        mod = path[:-3].replace("/", ".")
        if mod.endswith(".__init__"):
            pkg = mod[: -len(".__init__")]
            index[pkg] = path
            index[mod] = path
        else:
            index[mod] = path
    return index


def analyze(lang: str) -> tuple[dict[str, FileReport], dict[str, str]]:
    reports: dict[str, FileReport] = {}
    path_by_module: dict[str, str] = {}

    if lang in ("python", "all"):
        roots = [REPO_ROOT / r for r in PY_ROOTS]
        for f in collect_python_files(roots):
            r = analyze_python_file(f, REPO_ROOT)
            reports[r.path] = r
        path_by_module.update(_build_python_module_index(reports))

    if lang in ("typescript", "ts", "all"):
        src_root = REPO_ROOT / TS_SRC
        ts_reports: dict[str, FileReport] = {}
        for f in collect_ts_files(src_root):
            r = analyze_ts_file(f, REPO_ROOT, src_root)
            reports[r.path] = r
            ts_reports[r.path] = r
        # TS import edges already reference repo-relative file paths.
        for p in ts_reports:
            path_by_module[p] = p

    compute_fan(reports, path_by_module)
    for r in reports.values():
        score_report(r)
    return reports, path_by_module


def _print_text(
    reports: dict[str, FileReport], top: int, cycles: list[list[str]]
) -> None:
    ranked = sorted(reports.values(), key=lambda r: r.score, reverse=True)
    ranked = [r for r in ranked if r.score > 0][:top]

    print(f"\n  Code-health report — {len(reports)} files analyzed\n")
    header = f"  {'SCORE':>7}  {'LOC':>5}  {'MAXFN':>5}  {'CX':>4}  {'IN':>3}  {'OUT':>3}  FILE"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for r in ranked:
        print(
            f"  {r.score:7.0f}  {r.loc:5d}  {r.max_function_loc:5d}  "
            f"{r.max_complexity:4d}  {r.fan_in:3d}  {r.fan_out:3d}  {r.path}"
        )
        if r.reasons:
            print(f"           ↳ {'; '.join(r.reasons)}")
    if not ranked:
        print("  ✓ No files exceeded the health budgets.")

    print()
    if cycles:
        print(f"  ⚠ {len(cycles)} circular import group(s) detected:")
        for comp in cycles:
            print("    - " + " ↔ ".join(comp))
    else:
        print("  ✓ No circular imports detected.")
    print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.codehealth",
        description="Rank god files, map dependencies, and detect import cycles.",
    )
    parser.add_argument(
        "--lang",
        choices=["python", "typescript", "ts", "all"],
        default="all",
        help="Which ecosystem to analyze (default: all).",
    )
    parser.add_argument(
        "--top", type=int, default=25, help="How many files to list (default: 25)."
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit JSON instead of a text table."
    )
    parser.add_argument(
        "--max-score",
        type=float,
        default=None,
        help="CI gate: exit 1 if any file's score exceeds this value.",
    )
    parser.add_argument(
        "--fail-on-cycles",
        action="store_true",
        help="CI gate: exit 1 if any circular import is detected.",
    )
    args = parser.parse_args(argv)

    lang = "typescript" if args.lang == "ts" else args.lang
    reports, path_by_module = analyze(lang)
    cycles = find_cycles(reports, path_by_module)

    if args.json:
        ranked = sorted(reports.values(), key=lambda r: r.score, reverse=True)
        payload = {
            "files": [r.to_dict() for r in ranked if r.score > 0][: args.top],
            "cycles": cycles,
            "summary": {
                "files_analyzed": len(reports),
                "cycles": len(cycles),
                "max_score": round(
                    max((r.score for r in reports.values()), default=0.0), 2
                ),
            },
        }
        print(json.dumps(payload, indent=2))
    else:
        _print_text(reports, args.top, cycles)

    exit_code = 0
    if args.max_score is not None:
        worst = max((r.score for r in reports.values()), default=0.0)
        if worst > args.max_score:
            print(
                f"FAIL: max score {worst:.0f} exceeds budget {args.max_score:.0f}",
                file=sys.stderr,
            )
            exit_code = 1
    if args.fail_on_cycles and cycles:
        print(f"FAIL: {len(cycles)} circular import group(s) detected", file=sys.stderr)
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

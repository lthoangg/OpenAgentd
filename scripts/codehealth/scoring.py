"""God-file scoring and circular-import detection.

Scoring philosophy
------------------
LOC alone is a weak signal. A file is a *god file* when it is large **and**
hard to change safely. We blend four normalized signals:

  * size           — lines of code
  * function bloat — LOC of the single biggest function/method
  * complexity     — peak cyclomatic complexity in the file
  * coupling       — fan_in * fan_out (changing it ripples widely)

Each signal contributes points past a "healthy" threshold so small, simple
files score ~0 and only genuine offenders rise to the top.
"""

from __future__ import annotations

from scripts.codehealth.model import FileReport

# Thresholds beyond which a signal starts accruing score.
LOC_BUDGET = 400
FUNC_LOC_BUDGET = 60
COMPLEXITY_BUDGET = 12
HOOK_BUDGET = 12  # frontend components


def _over(value: int, budget: int, weight: float) -> float:
    return max(0, value - budget) * weight


def compute_fan(reports: dict[str, FileReport], path_by_module: dict[str, str]) -> None:
    """Populate ``fan_in`` / ``fan_out`` from the import edges.

    ``path_by_module`` maps an import key (python dotted module or repo path)
    to the repo-relative file path of the importable file, so we can count
    only edges that land on a file we actually analyzed.
    """
    fan_in: dict[str, int] = {p: 0 for p in reports}
    for report in reports.values():
        resolved_targets = set()
        for imp in report.imports:
            target = path_by_module.get(imp)
            if target and target in reports and target != report.path:
                resolved_targets.add(target)
        report.fan_out = len(resolved_targets)
        for t in resolved_targets:
            fan_in[t] = fan_in.get(t, 0) + 1
    for path, count in fan_in.items():
        reports[path].fan_in = count


def score_report(r: FileReport) -> None:
    """Compute the composite score and human-readable reasons in place."""
    reasons: list[str] = []
    score = 0.0

    loc_pts = _over(r.loc, LOC_BUDGET, 1.0)
    if loc_pts:
        score += loc_pts
        reasons.append(f"{r.loc} LOC (>{LOC_BUDGET})")

    func_pts = _over(r.max_function_loc, FUNC_LOC_BUDGET, 2.0)
    if func_pts:
        score += func_pts
        reasons.append(f"longest function {r.max_function_loc} LOC")

    cx_pts = _over(r.max_complexity, COMPLEXITY_BUDGET, 6.0)
    if cx_pts:
        score += cx_pts
        reasons.append(f"max complexity {r.max_complexity}")

    if r.language == "typescript":
        hook_pts = _over(r.num_hooks, HOOK_BUDGET, 4.0)
        if hook_pts:
            score += hook_pts
            reasons.append(f"{r.num_hooks} hook calls (state sprawl)")

    coupling = r.fan_in * r.fan_out
    if coupling:
        cpoints = coupling * 1.5
        score += cpoints
        reasons.append(f"coupling fan_in={r.fan_in} x fan_out={r.fan_out}")
    elif r.fan_in >= 8:
        score += r.fan_in * 1.0
        reasons.append(f"widely imported (fan_in={r.fan_in})")

    r.score = score
    r.reasons = reasons


def find_cycles(
    reports: dict[str, FileReport], path_by_module: dict[str, str]
) -> list[list[str]]:
    """Return distinct import cycles among analyzed files (Tarjan SCCs > 1)."""
    # Build adjacency over file paths.
    adj: dict[str, list[str]] = {p: [] for p in reports}
    for report in reports.values():
        for imp in report.imports:
            target = path_by_module.get(imp)
            if target and target in reports and target != report.path:
                adj[report.path].append(target)

    index = 0
    stack: list[str] = []
    on_stack: set[str] = set()
    indices: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    sccs: list[list[str]] = []

    import sys

    sys.setrecursionlimit(10000)

    def strongconnect(v: str) -> None:
        nonlocal index
        indices[v] = index
        lowlink[v] = index
        index += 1
        stack.append(v)
        on_stack.add(v)
        for w in adj[v]:
            if w not in indices:
                strongconnect(w)
                lowlink[v] = min(lowlink[v], lowlink[w])
            elif w in on_stack:
                lowlink[v] = min(lowlink[v], indices[w])
        if lowlink[v] == indices[v]:
            comp: list[str] = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                sccs.append(sorted(comp))

    for v in adj:
        if v not in indices:
            strongconnect(v)

    return sccs

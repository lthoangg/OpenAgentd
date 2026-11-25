#!/usr/bin/env python3
"""Model calls spent looking things up, and which of them a better tool would save.

Usage:
    python3 .agents/skills/oad/debug/scripts/round_trips.py [--days 14] [--db PATH]

A "step" is one model call that asked for tools (an assistant row with
``tool_calls``). A lookup step asks only for ``read``, ``grep``, ``glob`` or a
shell command that only reads, searches or lists. Each step re-reads the whole
context, so a chain of lookups costs one model call per link.

Reads ``session_messages`` read-only (``mode=ro``). Counts only; the few sample
lines it prints are tool arguments, never file content.

Traps:

1. **A re-read is waste only when nothing changed in between.** A compaction
   (``kind='summary'``) or a patch naming the file makes the second read
   legitimate, so both reset what counts as already read.
2. **Results are compared by length and their first 30,000 characters**, which is
   all this loads. Two reads of one file that differ only past that point would
   count as identical; ``read`` stops at 50,000, so few can.
3. **A shell command edits files this cannot see** (``sed -i``, a formatter), so
   "unchanged" over-counts a little where shell wrote the file.
4. **"Not named by the previous result" is an upper bound on what one step could
   have asked together.** The agent may have learned the path from the result's
   meaning, not its text. Treat it as a ceiling, not a count of mistakes.
5. **Do not use ``extra.duration_ms`` for a step's time**: it is not one model
   call. The time here is the gap between two assistant rows with no user
   message between them, ignoring gaps over 15 minutes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

CANDIDATES = [
    Path(os.environ.get("OPENAGENTD_DATA_DIR", "~/.local/share/openagentd")).expanduser() / "openagentd.db",
    Path(".openagentd/dev/data/openagentd.db"),
]
LOOKUP_TOOLS = {"read", "grep", "glob"}
SHELL_READ = {"cat", "bat", "head", "tail", "less", "nl"}
SHELL_SEARCH = {"rg", "grep", "egrep", "ag", "ack"}
SHELL_LIST = {"ls", "tree", "find", "fd", "wc", "stat", "file", "du"}
SHELL_NOISE = {"cd", "set", "export", "echo", "printf", "true", "(", "{", "do", "done", "then", "fi", "for", "if", "else"}
HIT = re.compile(r"^(.+?):(\d+): ", re.M)
HEADER = re.compile(r"^\[(\d+)-(\d+)/(\d+)\]")


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.0f}%" if d else "0%"


def norm(path: str) -> str:
    return path.strip().removeprefix("./").rstrip("/")


def number(value, default: int = 0) -> int:
    """A model's ``offset`` or ``limit``, which is not always a number."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def same_file(a: str, b: str) -> bool:
    a, b = norm(a), norm(b)
    return bool(a and b) and (a == b or a.endswith("/" + b) or b.endswith("/" + a))


def shell_lookup(command: str) -> tuple[bool, list[str], list[str]]:
    """``(only looks things up, the kind of each lookup segment, the segments)``."""
    kinds, segments, pure = [], [], True
    for segment in re.split(r"&&|\|\||;|\n", command):
        head = segment.split("|", 1)[0].strip()
        while re.match(r"^\w+=\S*\s", head):
            head = head.split(None, 1)[1].strip()
        tokens = head.split()
        if not tokens:
            continue
        token = tokens[0].rsplit("/", 1)[-1]
        if token in SHELL_NOISE:
            continue
        if re.search(r"(?<![\d&])>>?\s*[^&\s]", head) and "/dev/null" not in head:
            pure = False
            continue
        if token == "sed" and "-n" in tokens and "-i" not in tokens:
            kind = "read"
        elif token in SHELL_READ:
            kind = "read"
        elif token in SHELL_SEARCH:
            kind = "search"
        elif token in SHELL_LIST:
            kind = "list"
        else:
            pure = False
            continue
        kinds.append(kind)
        segments.append(segment.strip())
    return pure and bool(kinds), kinds, segments


class Step:
    __slots__ = ("calls", "tokens", "at", "model", "lookup", "kind", "gap")

    def __init__(self, calls, tokens, at, model):
        self.calls = calls  # [name, args, result, result_len]
        self.tokens, self.at, self.model = tokens or 0, at or 0.0, model or "?"
        self.lookup = False
        self.kind = ""
        self.gap = None  # seconds until the next model reply


def load(con: sqlite3.Connection, days: int):
    """Yield ``(session_id, is_subagent, [Step | 'user' | 'summary'])`` in order."""
    rows = con.execute(
        "select m.session_id, m.role, m.kind, m.tool_calls, m.tool_call_id, substr(m.content, 1, 30000), length(m.content),"
        " json_extract(m.extra, '$.usage.input'), julianday(m.created_at) * 86400.0, json_extract(m.extra, '$.model'),"
        " (select c.parent_session_id is not null from chat_sessions c where c.id = m.session_id)"
        " from session_messages m where m.created_at > datetime('now', ?) order by m.session_id, m.seq, m.id",
        (f"-{days} days",),
    )
    session, sub, items, by_id, last = None, False, [], {}, None
    for sid, role, kind, tool_calls, call_id, content, length, tokens, at, model, is_sub in rows:
        if sid != session:
            if items:
                yield session, sub, items
            session, sub, items, by_id, last = sid, bool(is_sub), [], {}, None
        if role == "assistant" and kind == "chat" and last is not None and at and 0 < at - last.at < 900:
            last.gap = at - last.at
        if role == "user" or kind == "summary" or role == "assistant":
            last = None
        if kind == "summary":
            items.append("summary")
        elif role == "user" and kind == "chat":
            items.append("user")
        elif role == "assistant" and tool_calls:
            try:
                parsed = json.loads(tool_calls)
            except ValueError:
                continue
            calls = []
            for call in parsed or []:
                fn = call.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                entry = [fn.get("name") or "?", args if isinstance(args, dict) else {}, "", 0]
                calls.append(entry)
                by_id[call.get("id")] = entry
            if calls:
                last = Step(calls, tokens, at, model)
                items.append(last)
        elif role == "tool" and call_id in by_id:
            by_id[call_id][2], by_id[call_id][3] = content or "", length or 0
    if items:
        yield session, sub, items


def median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description="Model calls spent on lookups.")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--db", type=Path)
    ap.add_argument("--samples", type=int, default=6)
    a = ap.parse_args()
    db = a.db or next((p for p in CANDIDATES if p.exists()), None)
    if not db:
        raise SystemExit("no openagentd.db found; pass --db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    steps = lookup_steps = single_lookup = 0
    tokens_all = tokens_lookup = 0
    gaps_lookup: list[float] = []
    by_kind: Counter[str] = Counter()
    single_by_kind: Counter[str] = Counter()
    by_owner: Counter[str] = Counter()
    lookup_by_owner: Counter[str] = Counter()
    transitions: Counter[str] = Counter()
    led = Counter()
    regrep: Counter[str] = Counter()
    opened_from: Counter[str] = Counter()
    long_by_owner: Counter[str] = Counter()
    tokens_by_owner: Counter[str] = Counter()
    before_match: list[int] = []
    after_match: list[int] = []
    calls_per_step: Counter[str] = Counter()
    chains: Counter[str] = Counter()
    chain_steps: Counter[str] = Counter()
    chain_models: Counter[str] = Counter()
    tool_calls: Counter[str] = Counter()

    opened = Counter()  # grep -> read of a matched file, by window
    opened_chars = Counter()
    glob_then_read = 0
    paging = Counter()
    grep_miss = grep_total = grep_retry = grep_capped = include_miss = 0
    brace_total = brace_miss = 0
    read_total = read_windowed = 0
    reread = reread_chars = reread_same = 0
    sliced: dict[tuple[str, str], list[tuple[int, int, int]]] = defaultdict(list)
    shell_total = shell_pure = shell_mixed = 0
    shell_segments: Counter[int] = Counter()
    shell_kinds: Counter[str] = Counter()
    shell_flags: Counter[str] = Counter()
    samples: dict[str, list[str]] = defaultdict(list)

    for sid, is_sub, items in load(con, a.days):
        owner = "subagents" if is_sub else "main agents"
        run = []  # the current chain of lookup steps
        seen: dict[tuple, tuple[str, int]] = {}
        prev: Step | None = None

        def close():
            n = len(run)
            if n:
                bucket = "1" if n == 1 else "2" if n == 2 else "3-4" if n <= 4 else "5-9" if n <= 9 else "10+"
                chains[bucket] += 1
                chain_steps[bucket] += n
                if n >= 3:
                    for s in run:
                        chain_models[s.model] += 1
                if n >= 10:
                    long_by_owner[owner] += n
            run.clear()

        for item in items:
            if item == "summary":
                seen.clear()
                close()
                prev = None
                continue
            if item == "user":
                close()
                prev = None
                continue
            step: Step = item
            steps += 1
            by_owner[owner] += 1
            tokens_all += step.tokens
            n = len(step.calls)
            calls_per_step["1" if n == 1 else "2" if n == 2 else "3-5" if n <= 5 else "6+"] += 1
            all_lookup = True
            native = shell_only = 0
            for name, args, result, length in step.calls:
                tool_calls[name] += 1
                if name in LOOKUP_TOOLS:
                    native += 1
                    continue
                if name == "shell":
                    shell_total += 1
                    command = str(args.get("command", ""))
                    pure, kinds, segments = shell_lookup(command)
                    if pure:
                        shell_pure += 1
                        shell_only += 1
                        shell_segments[min(len(kinds), 6)] += 1
                        for kind, segment in zip(kinds, segments):
                            shell_kinds[kind] += 1
                            if kind == "search":
                                if re.search(r"\s-\w*[ABC]\s*\d|\s-\w*[ABC]\d|--context|--after|--before", segment):
                                    shell_flags["search with context lines (-A/-B/-C)"] += 1
                                if re.search(r"\s-\w*c\b|\|\s*wc\b|--count", segment):
                                    shell_flags["search that only counts (-c, | wc)"] += 1
                                if re.search(r"\s-\w*l\b|--files-with-matches", segment):
                                    shell_flags["search that lists files only (-l)"] += 1
                                if re.search(r"\s-\w*o\b|--only-matching", segment):
                                    shell_flags["search that prints the match only (-o)"] += 1
                                if re.search(r"\|\s*(head|tail)\b", segment):
                                    shell_flags["search cut by head/tail"] += 1
                                if re.search(r"\|\s*(sort|uniq|awk|cut|sed)\b", segment):
                                    shell_flags["search reshaped (sort/uniq/awk/cut/sed)"] += 1
                            elif kind == "read":
                                if re.search(r"sed\s+-n", segment):
                                    shell_flags["read a line range (sed -n)"] += 1
                                if re.search(r"^\s*(head|tail)\b", segment):
                                    shell_flags["read the start or end (head/tail)"] += 1
                        if len(samples["shell lookup"]) < a.samples and len(kinds) >= 3:
                            samples["shell lookup"].append(" ".join(command.split())[:200])
                        continue
                    if kinds:
                        shell_mixed += 1
                all_lookup = False
            step.lookup = all_lookup
            names = {c[0] for c in step.calls}
            step.kind = (
                "shell" if not native else "mixed" if shell_only else "grep" if "grep" in names else "glob" if "glob" in names else "read"
            )

            for name, args, result, length in step.calls:
                if name == "grep":
                    grep_total += 1
                    hits = HIT.findall(result)
                    braces = "{" in str(args.get("include", ""))
                    brace_total += braces
                    if result.startswith("No matches"):
                        grep_miss += 1
                        brace_miss += braces
                        if "matched no file name" in result:
                            include_miss += 1
                    elif len(hits) >= (number(args.get("max_results"), 100) or 100):
                        grep_capped += 1
                if name != "read":
                    continue
                read_total += 1
                path = str(args.get("path", ""))
                offset, limit = number(args.get("offset"), 1) or 1, number(args.get("limit"))
                if limit:
                    read_windowed += 1
                header = HEADER.match(result)
                if header:
                    sliced[(sid, norm(path))].append((int(header[1]), int(header[2]), int(header[3])))
                key = (norm(path), offset, limit)
                fingerprint = (result, length)
                if key in seen and length and not result.startswith(("Error", "[Image")):
                    reread += 1
                    reread_chars += length
                    if seen[key] == fingerprint:
                        reread_same += 1
                seen[key] = fingerprint
            for name, args, _, _ in step.calls:
                if name == "patch":
                    text = str(args.get("patch_text", ""))
                    for key in [k for k in seen if k[0] and k[0] in text]:
                        del seen[key]

            if prev is not None:
                grep_hits = [(m[0], int(m[1])) for c in prev.calls if c[0] == "grep" for m in HIT.findall(c[2])]
                globbed = [line for c in prev.calls if c[0] == "glob" for line in c[2].splitlines()]
                prev_reads = [c for c in prev.calls if c[0] == "read"]
                if any(c[0] == "grep" and c[2].startswith("No matches") for c in prev.calls) and any(c[0] == "grep" for c in step.calls):
                    grep_retry += 1
                prev_greps = [c for c in prev.calls if c[0] == "grep"]
                if len(prev_greps) == 1:
                    old = prev_greps[0]
                    found = len(HIT.findall(old[2]))
                    outcome = "found nothing" if old[2].startswith("No matches") else "filled max_results" if found >= (number(old[1].get("max_results"), 100) or 100) else "had matches"
                    for c in step.calls:
                        if c[0] != "grep":
                            continue
                        same_pattern = c[1].get("pattern") == old[1].get("pattern")
                        same_place = c[1].get("directory", ".") == old[1].get("directory", ".") and c[1].get("include", "*") == old[1].get("include", "*")
                        change = "same pattern, another place" if same_pattern else "another pattern, same place" if same_place else "another pattern and place"
                        regrep[f"{outcome}: {change}"] += 1
                        if outcome == "found nothing" and len(samples["miss"]) < a.samples * 4:
                            show = lambda g: " ".join(json.dumps({k: g[1].get(k) for k in ("pattern", "directory", "include") if g[1].get(k)}).split())[:150]  # noqa: E731
                            samples["miss"].append(f"{show(old)}\n           then {show(c)}")
                        break
                for name, args, result, length in step.calls:
                    if name != "read":
                        continue
                    path = str(args.get("path", ""))
                    offset, limit = number(args.get("offset"), 1) or 1, number(args.get("limit"))
                    lines = [line for file, line in grep_hits if same_file(file, path)]
                    if lines:
                        if not limit:
                            bucket = "whole file (no limit)"
                        elif not any(offset <= line < offset + limit for line in lines):
                            bucket = "a window away from every match"
                        elif limit <= 40:
                            bucket = "window of 40 lines or fewer around a match"
                        elif limit <= 120:
                            bucket = "window of 41-120 lines around a match"
                        else:
                            bucket = "window over 120 lines around a match"
                        opened[bucket] += 1
                        opened_chars[bucket] += length
                        total_hits = len(grep_hits)
                        opened_from["a grep with 5 matches or fewer" if total_hits <= 5 else "a grep with 6-20 matches" if total_hits <= 20 else "a grep with over 20 matches"] += 1
                        if limit:
                            inside = [line for line in lines if offset <= line < offset + limit]
                            if inside:
                                before_match.append(min(inside) - offset)
                                after_match.append(offset + limit - 1 - max(inside))
                    elif any(same_file(line, path) for line in globbed):
                        glob_then_read += 1
                    for c in prev_reads:
                        if same_file(str(c[1].get("path", "")), path) and (number(c[1].get("offset"), 1) or 1) != offset:
                            if "read output truncated for LLM context" in c[2] or c[3] >= 49_000:
                                paging["after the 50,000-character stop"] += 1
                            elif c[1].get("limit"):
                                paging["after a window the agent chose"] += 1
                            else:
                                paging["other"] += 1
                            break

            if step.lookup:
                lookup_steps += 1
                lookup_by_owner[owner] += 1
                by_kind[step.kind] += 1
                tokens_lookup += step.tokens
                tokens_by_owner[owner] += step.tokens
                if step.gap:
                    gaps_lookup.append(step.gap)
                if n == 1:
                    single_lookup += 1
                    single_by_kind[step.kind] += 1
                if run:
                    before = run[-1]
                    transitions[f"{before.kind} -> {step.kind}"] += 1
                    if n == 1 and step.kind == "read":
                        path = str(step.calls[0][1].get("path", ""))
                        base = norm(path).rsplit("/", 1)[-1]
                        text = "\n".join(c[2] for c in before.calls)
                        if any(same_file(str(c[1].get("path", "")), path) for c in before.calls if c[0] == "read"):
                            led["the same file again"] += 1
                        elif base and base in text:
                            led["a file the previous result named"] += 1
                        else:
                            led["a file the previous result did not name"] += 1
                run.append(step)
            else:
                close()
            prev = step
        close()

    print(f"=== Lookup round trips, last {a.days}d ({db}) ===")
    print(f"\n--- Steps (model calls that asked for tools): {steps:,} ---")
    for bucket in ("1", "2", "3-5", "6+"):
        print(f"  {bucket:>4} calls in the step {calls_per_step[bucket]:>8,}  {pct(calls_per_step[bucket], steps)}")
    print(f"  lookup-only steps {lookup_steps:,} ({pct(lookup_steps, steps)} of steps); with a single call {single_lookup:,} ({pct(single_lookup, lookup_steps)})")
    for kind, n in by_kind.most_common():
        print(f"      {kind:<8}{n:>7,}   single call {single_by_kind[kind]:>6,} ({pct(single_by_kind[kind], n)})")
    for owner, n in by_owner.most_common():
        looked = lookup_by_owner[owner]
        print(
            f"      {owner:<12} {looked:>7,} of {n:>7,} steps are lookup-only ({pct(looked, n)}),"
            f" {tokens_by_owner[owner] / max(looked, 1) / 1000:,.0f}k input tokens each, {long_by_owner[owner]:,} of them in chains of 10+"
        )
    print(f"  context re-read by lookup-only steps: {tokens_lookup / 1e6:,.0f}M of {tokens_all / 1e6:,.0f}M input tokens ({pct(tokens_lookup, tokens_all)})")
    print(f"  from a lookup-only step to the next model reply: median {median(gaps_lookup):.1f} s, total {sum(gaps_lookup) / 3600:,.1f} h over {len(gaps_lookup):,} steps")

    print("\n--- Chains of consecutive lookup-only steps ---")
    total_chain_steps = sum(chain_steps.values())
    for bucket in ("1", "2", "3-4", "5-9", "10+"):
        print(f"  {bucket:>4} steps long: {chains[bucket]:>7,} chains, {chain_steps[bucket]:>7,} steps ({pct(chain_steps[bucket], total_chain_steps)})")
    long_steps = sum(chain_steps[b] for b in ("3-4", "5-9", "10+"))
    print(f"  steps in chains of 3 or more: {long_steps:,} ({pct(long_steps, steps)} of all steps)")
    for model, n in chain_models.most_common(5):
        print(f"      {model:<44}{n:>7,}")
    print("  what follows what, between two lookup-only steps in a row:")
    for label, n in transitions.most_common(12):
        print(f"      {label:<20}{n:>7,}")
    print("  a step with one read, right after another lookup-only step, opened:")
    for label, n in led.most_common():
        print(f"      {label:<44}{n:>7,}")

    print(f"\n--- read ({read_total:,} calls; {read_windowed:,} with a limit, {pct(read_windowed, read_total)}) ---")
    print(f"  same path, offset and limit read again with no patch or compaction between: {reread:,} ({pct(reread, read_total)}), {reread_chars / 1e6:.1f} MB")
    print(f"    of those, the result was identical: {reread_same:,}")
    pieces = [(k, v) for k, v in sliced.items() if len(v) >= 3]
    piece_calls = sum(len(v) for _, v in pieces)
    print(f"  files read in 3 or more slices in one session: {len(pieces):,} files, {piece_calls:,} calls")
    for label, low, high in (("300 lines or fewer", 0, 300), ("301-600 lines", 301, 600), ("601-1,500 lines", 601, 1500), ("over 1,500 lines", 1501, 10**9)):
        group = [v for _, v in pieces if low <= v[-1][2] <= high]
        covered = []
        for v in group:
            lines_read: set[int] = set()
            for start, end, _ in v:
                lines_read.update(range(start, end + 1))
            covered.append(100 * len(lines_read) / max(v[-1][2], 1))
        print(f"    {label:<20}{len(group):>5,} files, {sum(len(v) for v in group):>6,} calls, median {median(covered):.0f}% of the file read in the end")
    print("  a read in the step after a read of the same file at another offset:")
    for label, n in paging.most_common():
        print(f"    {label:<44}{n:>7,}")

    print(f"\n--- grep ({grep_total:,} calls) ---")
    print(f"  no matches: {grep_miss:,} ({pct(grep_miss, grep_total)}); of those, include matched no file name: {include_miss:,}")
    print(f"  include with braces, e.g. *.{{ts,tsx}}: {brace_total:,} calls, {brace_miss:,} found nothing ({pct(brace_miss, brace_total)}); without braces {pct(grep_miss - brace_miss, grep_total - brace_total)} find nothing")
    print(f"  a grep in the step after a grep that found nothing: {grep_retry:,}")
    print(f"  results that filled max_results: {grep_capped:,} ({pct(grep_capped, grep_total)})")
    print("  a grep in the step after a step with one grep, by how that grep ended and what changed:")
    for label, n in regrep.most_common():
        print(f"    {label:<52}{n:>7,}")
    for line in samples["miss"]:
        print(f"      miss {line}")
    total_opened = sum(opened.values())
    print(f"  a read in the step after a grep that matched that file: {total_opened:,}")
    for label, n in opened.most_common():
        print(f"    {label:<44}{n:>7,}  {opened_chars[label] / 1e6:>6.1f} MB")
    for label, n in opened_from.most_common():
        print(f"    after {label:<38}{n:>7,}")
    if before_match:
        b, c = sorted(before_match), sorted(after_match)
        q = lambda v, p: v[min(len(v) - 1, int(p * len(v)))]  # noqa: E731
        print(f"    lines read before the first match: median {q(b, 0.5)}, 75% within {q(b, 0.75)}, 90% within {q(b, 0.9)}")
        print(f"    lines read after the last match:   median {q(c, 0.5)}, 75% within {q(c, 0.75)}, 90% within {q(c, 0.9)}")
    print(f"  a read in the step after a glob that listed that file: {glob_then_read:,}")

    print(f"\n--- shell standing in for lookups ({shell_total:,} shell calls) ---")
    print(f"  only reads, searches or lists: {shell_pure:,} ({pct(shell_pure, shell_total)}); lookups mixed with other work: {shell_mixed:,}")
    print("  lookups per such call: " + ", ".join(f"{k}{'+' if k == 6 else ''}: {v:,}" for k, v in sorted(shell_segments.items())))
    print("  what they do: " + ", ".join(f"{k} {v:,}" for k, v in shell_kinds.most_common()))
    for label, n in shell_flags.most_common():
        print(f"    {label:<44}{n:>7,}")
    for line in samples["shell lookup"]:
        print(f"      e.g. {line}")

    print("\n--- Tool calls in the window ---")
    print("  " + ", ".join(f"{k} {v:,}" for k, v in tool_calls.most_common(8)))


if __name__ == "__main__":
    main()

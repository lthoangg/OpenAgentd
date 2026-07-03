"""Benchmark search quality over documents/ using testset.json.

For each (query, expected_paths) case, runs a turbovec search and checks
whether any expected path appears in the top-K results. Reports per-case
pass/fail plus aggregate Hit@1 / Hit@3 / Hit@5 and Mean Reciprocal Rank.

Usage:
    uv run --group experiment python experiments/turbovec_docs/benchmark.py
    uv run --group experiment python experiments/turbovec_docs/benchmark.py -k 10 -v
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sentence_transformers import SentenceTransformer
from turbovec import IdMapIndex

INDEX_PATH = Path("experiments/turbovec_docs/index/docs.tvim")
META_PATH = Path("experiments/turbovec_docs/index/docs_meta.json")
TESTSET_PATH = Path("experiments/turbovec_docs/testset.json")


def load_meta() -> tuple[dict[int, dict], str]:
    raw = json.loads(META_PATH.read_text(encoding="utf-8"))
    return {c["id"]: c for c in raw["chunks"]}, raw["model"]


def load_testset() -> list[dict]:
    raw = json.loads(TESTSET_PATH.read_text(encoding="utf-8"))
    return raw["cases"]


def first_hit_rank(result_paths: list[str], expected_paths: list[str]) -> int | None:
    """1-indexed rank of the first result whose path matches an expected path, or None."""
    expected = set(expected_paths)
    for rank, path in enumerate(result_paths, start=1):
        if path in expected:
            return rank
    return None


def run_benchmark(k: int, verbose: bool) -> None:
    if not INDEX_PATH.exists():
        raise SystemExit(f"No index at {INDEX_PATH}. Run build_index.py first.")

    meta_by_id, model_name = load_meta()
    cases = load_testset()
    model = SentenceTransformer(model_name)
    index = IdMapIndex.load(str(INDEX_PATH))

    queries = [c["query"] for c in cases]
    q_vecs = model.encode(queries, normalize_embeddings=True)
    all_scores, all_ids = index.search(q_vecs, k=k)

    hit_at_1 = 0
    hit_at_3 = 0
    hit_at_5 = 0
    reciprocal_ranks: list[float] = []
    failures: list[dict] = []

    for case, scores, ids in zip(cases, all_scores, all_ids):
        result_paths = [meta_by_id[int(cid)]["path"] for cid in ids]
        rank = first_hit_rank(result_paths, case["expected_paths"])

        reciprocal_ranks.append(1.0 / rank if rank else 0.0)
        if rank is not None:
            if rank <= 1:
                hit_at_1 += 1
            if rank <= 3:
                hit_at_3 += 1
            if rank <= 5:
                hit_at_5 += 1
        else:
            failures.append(
                {
                    "query": case["query"],
                    "expected": case["expected_paths"],
                    "got": result_paths[: min(5, k)],
                }
            )

        if verbose:
            status = f"rank={rank}" if rank else "MISS"
            print(f"[{status}] {case['query']!r} -> expected {case['expected_paths']}")
            if verbose and (rank is None or rank > 1):
                print(f"    got: {result_paths[: min(5, k)]}")

    n = len(cases)
    mrr = sum(reciprocal_ranks) / n

    print()
    print(f"Cases: {n}   Index size: {len(meta_by_id)} chunks   k={k}")
    print(f"Hit@1: {hit_at_1}/{n} ({hit_at_1 / n:.1%})")
    print(f"Hit@3: {hit_at_3}/{n} ({hit_at_3 / n:.1%})")
    print(f"Hit@5: {hit_at_5}/{n} ({hit_at_5 / n:.1%})")
    print(f"MRR:   {mrr:.3f}")

    if failures:
        print(f"\n{len(failures)} misses (expected path not found in top {k}):")
        for f in failures:
            print(f"  - {f['query']!r}")
            print(f"    expected: {f['expected']}")
            print(f"    got:      {f['got']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Benchmark search quality over documents/")
    parser.add_argument("-k", type=int, default=5, help="Top-K to evaluate (default 5)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print every case, not just misses")
    args = parser.parse_args()
    run_benchmark(args.k, args.verbose)

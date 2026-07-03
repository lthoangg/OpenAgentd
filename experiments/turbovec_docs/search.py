"""Search the documents/ turbovec index.

Usage:
    uv run --group experiment python experiments/turbovec_docs/search.py "how does session summarization work"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sentence_transformers import SentenceTransformer
from turbovec import IdMapIndex

INDEX_PATH = Path("experiments/turbovec_docs/index/docs.tvim")
META_PATH = Path("experiments/turbovec_docs/index/docs_meta.json")


def load_meta() -> dict[int, dict]:
    raw = json.loads(META_PATH.read_text(encoding="utf-8"))
    return {c["id"]: c for c in raw["chunks"]}, raw["model"]


def search(query: str, k: int = 5) -> None:
    if not INDEX_PATH.exists():
        raise SystemExit(f"No index at {INDEX_PATH}. Run build_index.py first.")

    meta_by_id, model_name = load_meta()
    model = SentenceTransformer(model_name)
    index = IdMapIndex.load(str(INDEX_PATH))

    q_vec = model.encode([query], normalize_embeddings=True)
    scores, ids = index.search(q_vec, k=k)

    print(f"Query: {query!r}\n")
    for rank, (score, cid) in enumerate(zip(scores[0], ids[0]), start=1):
        chunk = meta_by_id[int(cid)]
        snippet = chunk["text"].strip().replace("\n", " ")[:160]
        print(f"{rank}. score={score:.4f}  {chunk['path']}:{chunk['start_line']}-{chunk['end_line']}  '{chunk['heading']}'")
        print(f"   {snippet}...")
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Search documents/ via turbovec")
    parser.add_argument("query", help="Search query text")
    parser.add_argument("-k", type=int, default=5, help="Number of results")
    args = parser.parse_args()
    search(args.query, args.k)

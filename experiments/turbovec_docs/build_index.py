"""Build a turbovec IdMapIndex over documents/, embedded locally.

Usage:
    uv run --group experiment python experiments/turbovec_docs/build_index.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from turbovec import IdMapIndex

from chunker import chunk_documents

DOCS_ROOT = Path("documents")
OUT_DIR = Path("experiments/turbovec_docs/index")
INDEX_PATH = OUT_DIR / "docs.tvim"
META_PATH = OUT_DIR / "docs_meta.json"

# Local model, no API key, no network at query time. 384-dim, fast, good enough
# for this corpus size. Swap for a cloud embedding provider later if needed.
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def build() -> None:
    chunks = chunk_documents(DOCS_ROOT)
    if not chunks:
        raise SystemExit(f"No markdown chunks found under {DOCS_ROOT}")

    print(f"Chunked {len(chunks)} sections from {DOCS_ROOT}")

    model = SentenceTransformer(MODEL_NAME)
    texts = [c.text for c in chunks]
    vectors = model.encode(
        texts, batch_size=32, show_progress_bar=True, normalize_embeddings=True
    ).astype(np.float32)

    ids = np.array([c.id for c in chunks], dtype=np.uint64)

    index = IdMapIndex(dim=vectors.shape[1], bit_width=4)
    index.add_with_ids(vectors, ids)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index.write(str(INDEX_PATH))

    meta = {
        "model": MODEL_NAME,
        "chunks": [
            {
                "id": c.id,
                "path": c.path,
                "heading": c.heading,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "text": c.text,
            }
            for c in chunks
        ],
    }
    META_PATH.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"Wrote index: {INDEX_PATH} ({len(chunks)} vectors, dim={vectors.shape[1]})")
    print(f"Wrote metadata: {META_PATH}")


if __name__ == "__main__":
    build()

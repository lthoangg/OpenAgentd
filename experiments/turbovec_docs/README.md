# turbovec docs search (experiment)

Semantic search over `documents/` using [turbovec](https://github.com/RyanCodrai/turbovec)
as the vector index, with a local `sentence-transformers` model for embeddings.

This is a scoped experiment, not wired into the app. It's a proof of concept for
using turbovec as the vector store in a future memory/wiki system.

## Why local embeddings for now

`documents/` is ~1,000 chunks — far below the scale where turbovec's 16x
quantization matters. The point of this experiment isn't compression, it's
validating the search API/workflow. Local embeddings (`all-MiniLM-L6-v2`, 384-dim)
keep it dependency-light and offline; a cloud embedding provider (e.g. Gemini,
via the app's existing `google-genai` client) can be swapped in later behind the
same `build_index.py` / `search.py` interface.

## Setup

Dependencies live in the `experiment` uv group (not `dev`, not shipped in the
package or release build):

```bash
uv sync --group experiment
```

## Usage

```bash
# Chunk + embed + index documents/ (re-run after doc changes)
uv run --group experiment python experiments/turbovec_docs/build_index.py

# Query
uv run --group experiment python experiments/turbovec_docs/search.py "how does session summarization work"
uv run --group experiment python experiments/turbovec_docs/search.py "styling colors" -k 3

# Benchmark search quality against a hand-written testset (52 cases spanning
# every doc file: docs/, styling-specs/, techdebts/, top-level AGENTS.md)
uv run --group experiment python experiments/turbovec_docs/benchmark.py
uv run --group experiment python experiments/turbovec_docs/benchmark.py -k 3 -v   # print every case
```

### Current results (`all-MiniLM-L6-v2`, k=5, 52 cases)

| Metric | Score |
|---|---|
| Hit@1 | 88.5% |
| Hit@3 | 100% |
| Hit@5 | 100% |
| MRR | 0.939 |

The rare rank-2/3 misses are near-misses, not failures — the expected doc is
one of the next two results, and the doc that outranks it is usually
`docs/features.md` (a hub page that legitimately references most features
briefly). Re-run `benchmark.py -v` after changing the chunking strategy,
embedding model, or `documents/` content to catch regressions.

## How it works

- `chunker.py` — splits each `documents/**/*.md` file on markdown headings,
  keeping file path + line range + heading per chunk.
- `build_index.py` — embeds each chunk with a local sentence-transformers model,
  builds a turbovec `IdMapIndex` (4-bit, ids = chunk index), writes
  `index/docs.tvim` + `index/docs_meta.json` (chunk text/metadata sidecar,
  since turbovec only stores vectors + ids).
- `search.py` — embeds the query, calls `index.search()`, resolves ids back to
  chunk metadata for display.

`index/` is gitignored — it's a build artifact, regenerate it with
`build_index.py` after pulling doc changes.

## Known limitations

- Heading-only chunking can split code blocks or produce very small/large
  chunks; fine for this experiment, revisit if reused for real memory/wiki.
- No incremental re-index — `build_index.py` rebuilds from scratch every run.
- Local model quality is lower than commercial embedding APIs; expect
  reasonable-but-not-great recall on paraphrased queries.

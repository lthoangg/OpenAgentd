---
name: oad/search-doc
description: Semantic search over documents/ (OpenAgentd docs, styling specs, techdebt notes) using the turbovec experiment index. Use instead of grep when a query is conceptual/paraphrased rather than an exact string match.
---

Search `documents/` semantically instead of relying on exact-string `grep` — useful for
conceptual questions ("how does session summarization work", "what's the tech debt
around model capabilities") where the answer may not share the query's wording.

This wraps the experiment at `experiments/turbovec_docs/` (turbovec index +
local sentence-transformers embeddings). Reuse it, don't rebuild it.

## 1. Check the index exists

```bash
ls experiments/turbovec_docs/index/docs.tvim 2>/dev/null
```

- If missing, or if `documents/` has changed since the last build (new/edited/deleted `.md` files), build/rebuild it:

```bash
uv run --group experiment python experiments/turbovec_docs/build_index.py
```

This re-chunks every `documents/**/*.md` file and overwrites the index — cheap for this
corpus size, so rebuild whenever `documents/` might be stale rather than guessing.

## 2. Search

```bash
uv run --group experiment python experiments/turbovec_docs/search.py "<query>" -k 5
```

- Write the query as a natural-language question or description, not keywords — the
  embedding model matches meaning, not substrings.
- `-k` controls result count (default 5); raise it for broad/exploratory questions,
  lower it when you expect one clear answer.
- Output per result: similarity score, `path:start_line-end_line`, the section heading,
  and a text snippet — open the file at that line range for full context before quoting
  or acting on it.

## 3. When to fall back to grep/glob instead

- Exact identifiers, function/variable names, error strings, config keys → `grep` is
  faster and exact; semantic search adds noise for literal lookups.
- If the top result's score is low (roughly < 0.4) and doesn't look relevant, the corpus
  likely doesn't cover the question — say so rather than forcing a weak match into the answer.

## Notes

- This is a local, offline, no-API-key tool — safe to use freely, no network cost per query beyond the one-time model download (cached after first run).
- `experiments/turbovec_docs/README.md` has the full design rationale (chunking strategy, why local embeddings, known limitations) if deeper context is needed.
- The `experiment` uv dependency group is dev/local-only — never assume it's present outside this workspace's environment.

---
name: oad/search-doc
description: Semantic search over the retained OpenAgentd feature catalogue, ADRs, and repository instructions using the turbovec experiment index.
---

Search `documents/` semantically only for product-capability, decision-rationale, or repository-policy questions. The codebase, tests, CLI help, and UI are authoritative for implementation and operation; use `grep`, `glob`, and source reads for those questions.

This wraps the experiment at `experiments/turbovec_docs/` (turbovec index + local sentence-transformers embeddings). Reuse the index when current; rebuild it only after the retained Markdown corpus changes.

## 1. Check the index exists

```bash
ls experiments/turbovec_docs/index/docs.tvim 2>/dev/null
```

- If missing, or if `documents/` has changed since the last build, rebuild it:

```bash
uv run --group experiment python experiments/turbovec_docs/build_index.py
```

The corpus is intentionally small: feature catalogue, ADRs, and repository instructions. Rebuild whenever it might be stale rather than treating old search results as authoritative.

## 2. Search

```bash
uv run --group experiment python experiments/turbovec_docs/search.py "<query>" -k 5
```

- Use natural-language questions about shipped features, historical decisions, or repository documentation policy.
- `-k` controls result count (default 5); lower it when one clear result is expected.
- Open the returned file and line range before quoting or acting on a result.

## 3. Use source search instead when

- You need implementation behavior, API routes, schemas, configuration keys, CLI arguments, UI details, tests, or error strings.
- You are looking for an exact identifier, function/variable name, or literal text.
- The semantic result is low-confidence or the retained corpus does not cover the question.

## Notes

- This is local and offline after the one-time model download.
- `experiments/turbovec_docs/README.md` describes the experimental index and its limitations.
- The `experiment` uv dependency group is dev/local-only; never assume it exists outside this workspace.

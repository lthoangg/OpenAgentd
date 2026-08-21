# Manual Service Scenario Guide

These standalone Python scenarios are not collected by pytest. They exercise
service behavior against isolated temporary/file-backed SQLite and temporary
filesystems; `question_scenarios.py` can also write to a supplied copy of a
real database.

## Commands

```bash
make scenarios            # all maintained scenario groups
make scenarios-chat       # compaction, history visibility, undo/redo, queues
make scenarios-mentions   # mention parsing and workspace path safety
make scenarios-questions  # durable ask_user suspend/resume behavior
make scenarios-lsp        # LSP client/manager/hook behavior
make scenarios-performance
```

Run a script directly with `uv run python tests/manual/<script>.py` while
iterating. Each maintained script exits non-zero when a scenario fails.

## When to extend or rerun

- `manual_scenarios.py` / `extended_scenarios.py`: chat history visibility,
  compaction, healing, queue, and undo/redo behavior.
- `mention_scenarios.py`: mention context, attachment handling, or
  `_safe_join*` changes.
- `question_scenarios.py`: pending-question persistence and team
  suspend/resume changes. Pass only a disposable database copy.
- `lsp_scenarios.py`: `LspHook`, `LspManager`, diagnostics, formatting, managed
  provisioning, or `LspClient` changes.
- `performance_scenarios.py`: scheduler/session mutation query paths.

Add a focused isolated block to the existing owning script rather than
creating a parallel scenario runner.

---
title: Wiki Memory
description: Three-tier memory system — raw sessions (DB) → agent notes (wiki/notes/) → consolidated knowledge (wiki topics). Maintained by the dream agent.
status: stable
updated: 2026-04-30
---

# Wiki Memory

**Sources:** `app/services/wiki.py`, `app/services/dream.py`, `app/services/dream_scheduler.py`, `app/agent/hooks/wiki_injection.py`, `app/agent/tools/builtin/wiki_search.py`, `app/agent/tools/builtin/note.py`

Three tiers:

| Tier | What | Where |
|------|------|-------|
| Raw | All chat messages | SQLite (`session_messages`) |
| Episodic | Agent notes written mid-session | `wiki/notes/` |
| Wiki | Consolidated durable knowledge | `wiki/topics/`, `wiki/USER.md`, `wiki/INDEX.md` |

---

## Directory layout

```
{OPENAGENTD_WIKI_DIR}/
  USER.md           # stable user facts — injected into every prompt
  INDEX.md          # dream-maintained table of contents (user-editable)
  topics/           # durable knowledge base
    {slug}.md
  notes/            # agent notes (one file per day, append-only)
    {date}.md
```

`OPENAGENTD_WIKI_DIR` defaults to `.openagentd/wiki/` (dev) or `~/.local/share/openagentd-wiki/` (prod).

`USER.md` and `INDEX.md` cannot be deleted via the API — only overwritten.

---

## Components

### `WikiInjectionHook`

`app/agent/hooks/wiki_injection.py` — injects `USER.md` into the system prompt on every LLM call. Topics are never auto-injected — the agent calls `wiki_search` explicitly.

### `note` tool

`app/agent/tools/builtin/note.py` — appends a `## HH:MM UTC` entry to `wiki/notes/{date}.md`. One file per day, no frontmatter. The only write path to `wiki/notes/`.

### `wiki_search` tool

`app/agent/tools/builtin/wiki_search.py` — BM25 keyword search over `wiki/topics/`.

### Dream agent

`app/services/dream.py` — reads unprocessed sessions and note files, runs the dream agent with a fresh instance per item, writes to `topics/`, `USER.md`, `INDEX.md`. Tracks processed items in `dream_log` / `dream_notes_log`.

- Sessions with no messages are auto-skipped (marked processed, no batch slot consumed).
- The dream agent's sandbox workspace is set to `wiki_root()` so `ls(".")`, `read("USER.md")` etc. resolve correctly without a `wiki/` prefix.

`app/services/dream_scheduler.py` — cron scheduler. `reload()` takes effect without restart.

---

## `wiki/notes/` format

Plain markdown, no frontmatter. One file per day — all sessions append to it.

```markdown
## 14:32 UTC

User prefers Vim. Always use terminal-based editors.

## 14:45 UTC

Decided to use SQLite WAL mode for performance.
```

---

## `wiki/topics/{slug}.md` format

Required frontmatter (dream agent only):

```markdown
---
description: One-sentence summary (drives BM25 search relevance).
tags: [tag1, tag2]
updated: YYYY-MM-DD
---
```

---

## Dream agent config

`.openagentd/config/dream.md` — the dream agent's working directory is `wiki_root()`. Use bare paths (`USER.md`, `topics/slug.md`) not `wiki/USER.md`.

`read`, `write`, `ls`, `wiki_search` are always injected. `batch_size` (default `1`) controls items per `run_dream()` call. Configure via `/settings/dream` or edit the file directly; `PUT /api/dream/config` reloads the scheduler live.

---

## Data flow

```
Agent mid-session
  → note tool appends to wiki/notes/{date}.md

Every LLM call
  → WikiInjectionHook injects USER.md

Agent needs past context
  → calls wiki_search → BM25 over topics/

Dream runs (cron or manual)
  → empty sessions auto-skipped (no batch slot consumed)
  → fresh dream agent per item, sandbox = wiki_root()
  → writes topics/, USER.md, INDEX.md
  → marks processed in dream_log / dream_notes_log
```

---

## Path validation rules (`validate_wiki_path`)

All client-supplied paths go through `validate_wiki_path` in `app/services/wiki.py` before any disk operation. Rules:

- Must be relative (no leading `/` or `~`).
- Must end in `.md`.
- No `..` or `.` segments — checked against the **raw string** (not `Path.parts`) because `Path` silently normalises `topics/./test.md` → `('topics', 'test.md')` before the parts check runs.
- Root-level: only `USER.md` and `INDEX.md` are accepted.
- Sub-directory: only `topics/` and `notes/`.
- Max depth: 2 components (`dir/file.md`).
- Final `Path.resolve()` must remain inside `wiki_root()` (symlink-escape guard).

---

## What lives where

| Concern | Location |
|---------|---------|
| Wiki file ops, path validation | `app/services/wiki.py` |
| Data types (`WikiFileInfo`, `WikiTree`, `WikiPathError`) | `app/services/wiki.py` |
| Dream runner + empty-session filter | `app/services/dream.py` |
| Dream config parser (`parse_dream_md`, `DreamAgentConfig`) | `app/services/dream.py` |
| Dream scheduler (cron, `reload()`) | `app/services/dream_scheduler.py` |
| USER.md injection | `app/agent/hooks/wiki_injection.py` |
| Note writing | `app/agent/tools/builtin/note.py` |
| Topic search (BM25) | `app/agent/tools/builtin/wiki_search.py` |
| DB tables | `app/models/chat.py` (`DreamLog`, `DreamNotesLog`) |
| Migration | `app/migrations/versions/00000004_create_dream_log.py` |
| Seed defaults | `app/core/wiki_seed.py`, `seed/dream.md` |
| Manual scripts | `manual/wiki.py`, `manual/note.py`, `manual/dream.py` |

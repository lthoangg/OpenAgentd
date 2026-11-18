---
title: Features
description: Canonical, version-cited catalogue of shipped user-visible OpenAgentd features.
status: stable
updated: 2026-11-18
---

# Features

The canonical source of truth for shipped user-visible capabilities. Every feature lists the
release that introduced it (where known). When you ship something new, **add it to its area file first** (linked below) — README and external copy should cite the catalogue.
For a guided tour of these features, see [openagentd.dev/features](https://openagentd.dev/features/).

> **Headline.** OpenAgentd is a coding-first desktop workspace for a local coding agent — a
> double-clickable app that runs an agent on your machine, with a
> real UI to watch every step. Open source (Apache 2.0). 18 built-in providers. Your keys.

**Latest release:** v3.60.0 · November 18, 2026 · [release notes](https://github.com/lthoangg/openagentd/releases/tag/v3.60.0)

---

## How this document is organised

This page is the index. Entries live in one file per area under [`features/`](features/), grouped by
**pillar** — the same surfaces that drive the product narrative on slides and in the README. To find or
add a feature, open the area file its pillar lists below.

Conventions used in every area file:

- `[v2.X.Y]`, `[v1.X.Y]` — release that shipped the feature (where known).
- `[since v1.0]` — present in the v1 line; no precise version known.
- *(beta)* — experimental, may change. *(deprecated)* — removed or replaced.
- Indented sub-bullets are user-visible details, not separate features.

---

## 1. The desktop coding workspace

The product's primary coding surface. A native double-click app on macOS, Windows,
and Linux that hosts the same backend sidecar + React UI you would otherwise
run from the terminal (the native Rust binary since v3.0.0).

- [Engine, speed and connection](features/app-engine.md) — The Rust backend, startup and streaming speed, the connection to the server, crash recovery, versions and in-app updates.
- [Other computers and remote control](features/app-remote-access.md) — Reaching a server from another device: the server list, network access, access keys, and remote control.
- [Settings](features/app-settings.md) — The Settings dialog: its pages, search, and how changes are saved.
- [Chat and transcript](features/app-transcript.md) — Reading a session: the transcript, replies as they stream, Markdown, tool rows, Plan and Code modes, and questions from the agent.
- [Composer](features/app-composer.md) — Writing a message: the composer, the run controls under it, attachments, mentions, slash commands and drafts.
- [Sidebar, palette and shortcuts](features/app-navigation.md) — Finding and switching: the sidebar, the command palette, keyboard shortcuts, native menus, windows and session titles.
- [Review panel](features/app-review-panel.md) — The Review panel: panes and views, Git, files, the file viewer, previews and tasks.
- [Look, motion and accessibility](features/app-look-and-feel.md) — How the app looks and moves: type and contrast, borders, motion, feedback, Simple and Full detail, and wording.
- [Phones and tablets](features/app-phone.md) — The phone layout and the iOS and Android apps: navigation, typing, widgets, and store channels.
- [Desktop shell](features/app-desktop.md) — The desktop app: windows, notifications, the tray, the notch and the pet.

---

## 2. Agent runtime

- [Agent runtime](features/agent-runtime.md) — The turn loop, subagents, goals, plans, scheduling, and how a session runs.

---

## 3. The coding workspace

- [The coding workspace](features/coding-workspace.md) — Working in a project folder: worktrees, snapshots and undo, Git, LSP, and workspace rules.

---

## 4. Memory and context

- [Memory and context](features/memory-and-context.md) — Summarization, memory pages, instructions files, and what the agent carries between turns.

---

## 5. Providers and models

- [Providers and models](features/providers-and-models.md) — Supported providers, sign-in, model choice, thinking levels, accounts and backup models.

---

## 6. Built-in tools

- [Built-in tools](features/built-in-tools.md) — The tools the agent can call without extra setup.

---

## 7. Extension surface

- [Extension surface](features/extension-surface.md) — Skills, MCP servers, plugins and commands.

---

## 8. Path denylist and permissions

- [Path denylist and permissions](features/permissions.md) — The trust model, blocked files, and what the agent may touch.

---

## 9. Observability

- [Observability](features/observability.md) — Logs, telemetry, usage and cost, all kept on the machine.

---

## 10. Voice

No voice features ship at present: OpenAgentd has no microphone input and runs no speech recognition.

---

## 11. Distribution and updates

- [Distribution and updates](features/distribution-and-updates.md) — Installers, the CLI, release channels, and how each surface updates.

---

## 12. Embed and API

- [Embed and API](features/embed-and-api.md) — The HTTP and SSE API the apps use, for other clients.

---

## Not yet shipped

Future work and known issues are tracked in [GitHub issues](https://github.com/lthoangg/OpenAgentd/issues), not in this feature catalogue.

When a feature ships, add it to the right area file with its `[vX.Y.Z]` tag.

---

## How to update this document

When you ship a user-visible change:

1. Find the pillar above and open its area file. Read the file: update the entry that already
   describes the feature instead of adding a second one.
2. Add a new feature as a one-line entry with the `[vX.Y.Z]` tag of the release it ships in.
3. If no area fits, add an area file under `features/` and link it from its pillar here. Do not
   shoehorn unrelated work into an existing area. An area file stays under 50 KB; split one that grows past it.
4. If the change is important to the product story or setup, also update
   [`../../README.md`](../../README.md).
5. If the change is technical / architectural, keep its non-obvious rationale
   beside the implementation; git history preserves the historical decision.
6. If you remove a feature, mark it *(deprecated)* in place for at least one
   release before deleting the entry.

The release script updates the `updated:` field and the **Latest release** line on this page.

This catalogue is the **canonical** answer to "what does OpenAgentd do?". Slides,
README copy, comparison docs, marketing posts, and investor decks should all
trace their claims back to a line in it.

---
title: Roadmap
description: Public roadmap for OpenAgentd — short priority list plus links to GitHub issues.
status: living
updated: 2026-06-25
---

# Roadmap

OpenAgentd is Apache 2.0 and developed in the open. This page is intentionally
short: shipped capabilities live in [`features.md`](./features.md), feature
requests live as GitHub issues, and known issues live as GitHub issues labeled
[`known issue`](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22known%20issue%22).

## Planning rules

- **No dated promises.** One maintainer, real life. Issue labels and comments are
  the source of truth for priority, scope, and status.
- **`features.md` is the past. GitHub issues are the future.** When a feature
  ships, close the issue and add the shipped capability to
  [`features.md`](./features.md) with its `[vX.Y.Z]` tag.
- **Known issues stay out of the roadmap.** Track them as GitHub issues with the
  `known issue` label.
- **Disagree publicly.** Comment on an issue with the concrete use case, or open
  a new issue if nothing exists yet.

## Current priorities

These are the important feature tracks for the next planning cycle. The full
backlog is on GitHub:
[`roadmap`](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap),
[`enhancement`](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3Aenhancement), and
[`known issue`](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22known%20issue%22).

| Track | Issues |
|---|---|
| Chat usage visibility | [#112 Show per-response and cumulative token totals](https://github.com/lthoangg/OpenAgentd/issues/112) |
| Inspector and cockpit navigation | [#85 Group explored tool calls](https://github.com/lthoangg/OpenAgentd/issues/85), [#86 Add menubar navigation](https://github.com/lthoangg/OpenAgentd/issues/86) |
| Local-first UI state | [#87 Persist UI state on disk instead of localStorage](https://github.com/lthoangg/OpenAgentd/issues/87) |
| Provider and migration coverage | [#105 Qwen](https://github.com/lthoangg/OpenAgentd/issues/105), [#106 LM Studio](https://github.com/lthoangg/OpenAgentd/issues/106), [#107 Claude access](https://github.com/lthoangg/OpenAgentd/issues/107), [#108 Claude Code / Codex CLI / opencode migrations](https://github.com/lthoangg/OpenAgentd/issues/108) |
| Coding workspace ergonomics | [#88 Line-range file mentions](https://github.com/lthoangg/OpenAgentd/issues/88), [#98 Git worktree support](https://github.com/lthoangg/OpenAgentd/issues/98), [#99 Auto-format after edits](https://github.com/lthoangg/OpenAgentd/issues/99) |
| Memory | [#101 Per-project wiki memory](https://github.com/lthoangg/OpenAgentd/issues/101), [#102 Cross-session conversation search](https://github.com/lthoangg/OpenAgentd/issues/102), [#104 Rework broader wiki and memory architecture](https://github.com/lthoangg/OpenAgentd/issues/104) |
| Future architecture fork | [#119 Decouple CLI/server from the desktop shell](https://github.com/lthoangg/OpenAgentd/issues/119) |

## Issue index

Use GitHub issues for feature requests, roadmap discussion, and known issues:

- [Open roadmap items](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3Aroadmap)
- [Open feature requests / enhancements](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3Aenhancement)
- [Open known issues](https://github.com/lthoangg/OpenAgentd/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22known%20issue%22)
- [All open issues](https://github.com/lthoangg/OpenAgentd/issues)

## How to contribute

- **Request a feature.** Open an issue with the `enhancement` label and describe
  the concrete workflow it unlocks.
- **Report a known issue.** Open an issue with reproduction steps, expected
  behavior, actual behavior, logs/screenshots if available, and the `bug` label.
  Maintainers add `known issue` when it is confirmed.
- **Champion a roadmap item.** Comment on the existing issue with your use case,
  design notes, or willingness to test.

When an item ships, close the issue, move the shipped behavior to
[`features.md`](./features.md), and bump that file's `updated:` date.

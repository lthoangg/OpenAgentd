---
title: Change Validation, Context, and Friction Policy
description: Risk-based validation lanes, bounded repository context, and feedback capture for contributors and agents.
status: stable
updated: 2026-07-14
---

# Change Validation, Context, and Friction Policy

Use this policy to choose proportionate validation before opening a pull request. It is the canonical policy for contributors and coding agents; it complements the commands in [Developer Guidelines](../guidelines.md). The portable pre-merge contract is [`make verify`](../../../Makefile); use its focused `verify-backend`, `verify-web`, `verify-docs`, and `verify-version` targets when appropriate. Native verification is separate because it requires platform dependencies.

## Lanes and hard gates

Choose the highest lane a change reaches. A reviewer can raise the lane when the affected surface or failure mode warrants it.

| Lane | Typical scope | Required evidence |
|------|---------------|-------------------|
| **Tiny** | Markdown-only correction, comment, or isolated formatting with no behavior change | Inspect the diff; verify changed links or paths. |
| **Normal** | Localized behavior, test, API, UI, configuration, or dependency change | Run the applicable rows in the matrix below and report results. |
| **High-risk** | Authentication, authorization, secrets, untrusted input, filesystem or subprocess behavior, migrations, release/versioning, public API compatibility, provider prompts, or native/mobile packaging | Satisfy all applicable matrix rows, add focused regression coverage or explain why it is infeasible, and document residual risk for review. |

Hard gates apply regardless of lane:

1. Do not merge a failing applicable check without an explicit maintainer decision and a tracked follow-up.
2. Security-sensitive changes require a security review; vulnerabilities are reported privately, not in public issues or pull requests.
3. Schema/migration changes require an upgrade and rollback or recovery consideration.
4. Public API, prompt, or version changes require compatibility/release impact to be stated.
5. Web UI changes require narrow and wide viewport verification when the changed UI can render on either surface.

## Files-to-required-checks matrix

Run the focused tests first, then the listed checks that apply to the changed files. Record exact commands and outcomes in the PR.

| Changed area or signal | Required checks / evidence |
|---|---|
| `app/`, `tests/` (backend) | Focused `uv run pytest <path>`; then `make verify-backend`. |
| `web/` | Focused `cd web && bun test --parallel <path>` when available; then `make verify-web`; also run `cd web && bun run build` for build, routing, or bundle-affecting changes. |
| `desktop/` or `mobile/` native code/configuration | Focused native check or test from the affected `src-tauri` project; then `make verify-native`, or the affected `make verify-desktop` / `make verify-mobile` target; verify the affected behavior or state why the platform was unavailable. |
| Alembic migrations, SQLModel schema, or persisted data | Apply the migration in a disposable development database (`make migrate`); exercise the changed persistence path; state rollback/recovery behavior. |
| Auth, tokens, permissions, MCP, shell/subprocess, file paths, uploads, or model/external input | Security review; focused adversarial/negative test; confirm no secrets or personal data are included in the diff, logs, or screenshots. |
| `app/api/`, API schemas, SSE payloads, or API docs | Route/schema tests; verify request and response compatibility, error behavior, and any affected API documentation. |
| Mention helpers or workspace attachment/path handling | Focused tests and `uv run python tests/manual/mention_scenarios.py`. |
| LSP client, manager, diagnostics, or hook behavior | Focused tests and `uv run python tests/manual/lsp_scenarios.py`. |
| Version, changelog/release metadata, packaging, or dependency locks | Run `make verify-version` plus the relevant package/build validation; state release and compatibility impact. |
| Documentation, `AGENTS.md`, or documented Make targets | Run `make verify-docs`; run the product check too when documentation changes commands or behavior. |
| Agent instructions, skills, system prompts, command prompts, or provider prompt assembly | Review the rendered/assembled prompt for scope, secrets, and contradictory instructions; run `make prompt-budget` when assembled prompt size can change; add or update focused coverage when prompt output is testable; state expected behavior change. |

Use the existing manual scenarios only when their named surface changes; they are not a substitute for focused automated tests. For a live server issue, use the appropriate `manual/` smoke helper from `manual/AGENTS.md`.

## Bounded context retrieval

Start with the assigned files, their nearest instructions, direct callers/callees, and existing tests. Retrieve more context only when one of these triggers appears:

- a contract crosses a module boundary (API, schema, event, config, or type);
- a changed symbol has callers, overrides, generated artifacts, or matching tests outside the initial scope;
- a security, persistence, workspace-path, provider, native, or mobile boundary is involved;
- a test, build, or review finding identifies a concrete dependency; or
- repository guidance explicitly names a required companion document or scenario.

For each trigger, read the smallest directly relevant file set and return to implementation. **Stop** expanding context when the change boundary, applicable matrix rows, and acceptance evidence are identified and each additional file would not change the implementation or validation decision. Do not perform broad repository archaeology merely to appear thorough.

## Capture agent and repository friction

Capture repeatable friction in the existing GitHub issue tracker using the **Agent / repository friction** template. Use `documents/techdebts/` when the item is an accepted, repository-owned debt rather than a request for triage; do not create a parallel tracker.

A useful record includes:

- the exact blocked workflow and minimal reproduction;
- the predicted impact (time, reliability, security, or contributor reach);
- the proposed completion proof: command, scenario, or observable outcome;
- the actual outcome after work is attempted or completed, including any residual limitation; and
- links to related PRs, issues, or tech-debt notes.

Close or update the record after outcome review. This keeps friction reports actionable rather than turning them into an unbounded backlog.

## PR reporting

Use the pull-request template to declare risk flags, commands and manual scenarios run, mobile narrow/wide checks where applicable, and residual risk. A concise "not applicable" is sufficient when a matrix row does not match the diff.

## Related references

- [Developer Guidelines](../guidelines.md)
- [Contributing guide](../../../CONTRIBUTING.md)
- [Manual scenario catalogue](../../../manual/AGENTS.md)
- [GitHub issues and roadmap](../roadmap.md)
- [Tracked technical debt](../../techdebts/)

---
name: oad/commit
description: OpenAgentd commit workflow — check the staged diff, sync the feature catalogue, and write a conventional commit (Motivation / Technical Changes / Impact). Use whenever the user asks to commit.
---

Commit only what belongs to the change, with the documentation it needs.

## 1. Stage deliberately

```bash
git status --short
git diff --cached --stat
```

- If nothing is staged, stage the files of the change you made (`git add <paths>`).
  Never sweep in unrelated work the user left in the tree; ask when ownership is unclear.
- New files, deletions, and renames count: check `??` and `D` entries.

## 2. Check the staged diff

Read `git diff --cached`. Stop and report (file and line) instead of committing when it contains:

- debug leftovers: stray `console.log`, `dbg!`, `println!`, `print()`, enabled debug flags;
- temporary or rigged code: "temp", "wip", hardcoded test data, mocked responses in source;
- commented-out code blocks, or new TODO / FIXME / HACK markers.

## 3. Sync documentation

Pick the smallest durable record for what changed:

| Change | Record |
|---|---|
| Shipped user-visible capability or behavior change | Version-cited entry in `documents/docs/features.md` (the canonical catalogue). Use the next release version; mark removed features *(deprecated)* for at least one release before deleting them. |
| Product story or first-run/setup change | `README.md` |
| Non-obvious invariant, security, or architecture rationale | A comment beside the code (why, not what) |
| Future work, bugs, roadmap | A GitHub issue, never a repository doc |
| Implementation, API, config, CLI, UI detail | Nothing: source, tests, CLI help, and the UI are authoritative |
| Repository policy or tooling | The nearest `AGENTS.md` or the matching `.agents/skills/oad/*` skill |

Do not create guides, API references, or troubleshooting pages under `documents/`.
After any Markdown change run `make verify-docs`: it checks frontmatter, local links,
`AGENTS.md` references, and that every backticked `make <target>` exists.
If nothing user-visible changed, say so in one line of the commit body.

## 4. Size the commit

- One logical change per commit: aim for ~100 changed lines, ~300 for one cohesive change; split ~1000+.
- Keep refactors and behavior changes in separate commits.
- Do not force a split when the pieces depend on each other.

## 5. Write the message

```
<type>(<optional scope>): <imperative subject, ≤72 chars>

Motivation:
<why this change, what was wrong or missing>

Technical Changes:
- <one bullet per meaningful change, naming files or modules>

Impact:
<user-visible effect, risk, follow-ups; or "No user-visible change.">
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `style`, `ci`.
Scopes in use: `web`, `desktop`, `mobile`, `appv3` (or a crate such as `api`, `agent`), `scripts`.

## 6. Commit

```bash
git commit -F - <<'EOF'
<message>
EOF
git log --oneline -1
```

Pre-commit hooks run file hygiene, `oxlint`, and `tsc` for `web/`. If a hook fails,
fix the cause and commit again; never bypass it with `--no-verify`.
Report the hash and a one-line summary. Do not push unless asked.

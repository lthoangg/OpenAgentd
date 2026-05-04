---
applicable_to: Release a new version of OpenAgentd
description: Bump the version by PR, then publish the GitHub release.
subtask: false
---

## Steps

1. Read `app/version.txt`, propose a patch bump, and ask if minor/major is preferred.

2. Check worktree. Stop if dirty.

```bash
git status --short
```

3. Ask and wait:

> Ready to release **`<version>`**. Proceed? **(yes / no)**

4. On a PR branch, update `app/version.txt`, `pyproject.toml`, `web/package.json`, and `uv.lock`.

```bash
uv sync
uv run ruff format app/ tests/
uv run ruff format --check app/ tests/
git add app/version.txt pyproject.toml uv.lock web/package.json
git commit -m "chore: bump version to <version>"
git push -u origin <branch>
gh pr create --title "chore: bump version to <version>" --base main
```

Wait for CI and merge the PR.

5. After merge, generate release notes.

```bash
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)
git log ${PREV_TAG}..HEAD --oneline --no-merges
```

Write concise, user-facing notes in this style:
- Start with `## Breaking Changes` only if migration is required.
- Use `## What's changed` for the main narrative.
- Add `## Upgrade` only when users need action.
- Mention tests briefly if relevant.
- Include short examples only when they clarify behavior.
- End with `**Full changelog:** https://github.com/lthoangg/openagentd/compare/<prev>...<next>`.

Skip version bump commits. Use commit subjects as source material, not as the final structure.

6. Trigger release.

```bash
gh workflow run release.yml --field confirm=release
gh run list --workflow=release.yml --limit=3
```

7. Replace GitHub release notes:

```bash
gh release edit v<version> --repo lthoangg/openagentd --notes "<release notes>"
```

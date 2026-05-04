---
applicable_to: Create a pull request to main
description: Summarize the current branch, push it, and open a PR to main.
subtask: false
---

## Steps

1. Check branch/worktree. Stop on `main` or dirty state.

```bash
git branch --show-current
git status --short
```

2. Inspect changes. Stop if no commits are ahead.

```bash
git fetch origin main
git log --oneline --no-merges origin/main..HEAD
git diff --stat origin/main...HEAD
```

3. Reuse an existing PR if present.

```bash
gh pr view --json url,title,baseRefName,headRefName
```

4. Push and create the PR.

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<type>: <subject>" --body "$(cat <<'EOF'
## Summary
- <change summary>

## Validation
- `<command>`
EOF
)"
```

Output the PR URL.

---
description: Show current working state after a /clear so you can resume where you left off.
---

Run the following and show me the results so I can re-orient:

1. `git branch --show-current` — what branch am I on
2. `git status --short` — what files are changed
3. `git diff --cached --stat` — what is staged
4. `git log --oneline --no-merges origin/main..HEAD` — what commits exist ahead of main
5. `gh issue list --repo lthoangg/openagentd --state open --assignee @me --limit 10` — my open issues

Show the raw output of each, then give me a one-paragraph summary of where things stand and what the most likely next step is.

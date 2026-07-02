---
description: Load a GitHub issue into context and identify where to start.
---

Run: `gh issue view $ARGUMENTS --repo lthoangg/openagentd --comments`

Read the full issue body and comments. Then:
1. Summarize what is being asked in 2–3 sentences.
2. Identify the most likely files or subsystems involved — check the nearest `AGENTS.md` for where to look.
3. Say whether this looks like a bug (→ `oad/debug`), a feature (→ `oad/plan`), or a docs/chore.

Do not write any code yet.

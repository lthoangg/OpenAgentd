---
name: oad/commit
description: OpenAgentd workflow for well-formatted, detailed conventional commits.
---

Git Commit Execution Workflow

1. **Stage**: Run `git status --porcelain`. If no files are staged, execute `git add .`.
2. **Analyze**: Run `git diff --cached` to evaluate the technical scope and architectural impact (e.g., DDD shifts or C4 updates).
3. **Sync Docs**: Update related documentation files automatically to align with the changes made in the codebase.
4. **Generate Message**:
   - **Format**: `<type>: <subject>`
   - **Subject**: Auto-generate a concise imperative subject from the staged changes.
   - **Body**: Leave a blank line, then detail **Motivation**, **Technical Changes** (bulleted deep-dive), and **Impact**.
5. **Commit**: Execute `git commit -m "<message>"` and output the commit hash and a brief summary.

Note: Multiple commits are preferred for large changes. If the scope is too broad, break it down into smaller, focused commits following the same workflow (do not force to have multiple commits if the change is small and cohesive).

**Sizing:** target ~100 changed lines per commit (a single logical, self-contained change); ~300 is acceptable for one cohesive change; ~1000+ should be split. Keep refactors and behavior changes in separate commits — mixing "renamed X" with "fixed Y" makes both harder to review and revert.

---

**Commit Conventions**

| Category | Type |
| :--- | :--- |
| **Features** | `feat` |
| **Fixes** | `fix` |
| **Refactor** | `refactor` |
| **Maintenance** | `chore/docs` |
| **Style** | `style` |

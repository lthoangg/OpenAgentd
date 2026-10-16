---
description: Run the code health check and identify the highest-impact refactor targets.
---

Run: `make health`

Review the output and tell me:
1. The top 3–5 worst files by health score and specifically why each ranks poorly.
2. Any circular imports detected.
3. One concrete, actionable refactor suggestion for the single worst offender — what to extract, move, or split, and why it would help.

Analysis only — do not make any changes.

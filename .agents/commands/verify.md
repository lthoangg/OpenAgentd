---
description: Run repository verification checks covering modified files and summarize any failures.
---

Run `python3 scripts/verify_changed.py --list` to print the gates that cover the changed paths, then `make verify-changed` to run them. The path table in `scripts/verify_changed.py` decides which gates apply; do not choose them by hand.

Report each gate's status, and give concise fix instructions for any that fail.

$ARGUMENTS

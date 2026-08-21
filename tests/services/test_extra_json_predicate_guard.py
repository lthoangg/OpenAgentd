"""Guard: no SQL predicates over the ``extra`` JSON column on hot paths.

The seq/kind remodel moved every hot-path decision (visibility, LLM window,
queueing, compaction) onto real columns.  ``extra`` is display metadata plus a
couple of cold, LIMIT-1 lookups.  This test fails when someone reintroduces a
JSON-extract predicate outside the explicit whitelist, so the regression is
caught at review time rather than as a slow query in production.
"""

from __future__ import annotations

import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2] / "app"

# (relative file, containing function) pairs allowed to query extra via SQL.
# Both are cold paths: from_agent backs LIMIT-1 undo/redo target lookups and
# attachment_for cleans up a single queued message's synthetic rows.
WHITELIST = {
    ("services/chat_service_revert.py", "from_agent"),
    ("services/chat_service_queue.py", "_ATTACHMENT_FOR_KEY"),
}

PATTERN = re.compile(r"col\(SessionMessage\.extra\)\[(?P<key>[^\]]+)\]")


def test_extra_json_sql_predicates_are_whitelisted():
    found: set[tuple[str, str]] = set()
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for match in PATTERN.finditer(text):
            key = match.group("key").strip("\"'")
            found.add((path.relative_to(APP_DIR).as_posix(), key))
    assert found == WHITELIST, (
        "SQL predicates over SessionMessage.extra changed. Hot paths must use "
        "real columns (seq/kind/pinned); extend the whitelist only for cold, "
        f"LIMIT-1 lookups. Unexpected: {sorted(found - WHITELIST)}, "
        f"missing: {sorted(WHITELIST - found)}"
    )

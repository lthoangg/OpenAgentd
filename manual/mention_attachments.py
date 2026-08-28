"""Smoke-test @-mention auto-attachment for team chat.

Sets up a temp coding workspace with fixtures, sends a chat message that
mentions a small text file, a large text file, an image, and a folder,
then reads:

  * the API history response — verifies attachment metadata (no internal
    fields leaked, no converted_text in the public response)
  * the DB directly — verifies synthetic hidden rows were written with
    the correct fenced content, and that file content / truncation
    markers are present in those rows

Checks:
  * note.txt   → attached, synthetic row has [File: note.txt] fence
  * big.txt    → attached, synthetic row truncated head+tail
  * photo.png  → NOT attached (image mentions are reference-only)
  * report.pdf / spec.docx → NOT attached (document mentions are Read-tool references)
  * subdir/    → resolved to subdir/AGENTS.md, synthetic row present
  * "@quoted.txt" (inside quotes) → still resolves

The queue-path branch (mentions when the lead is busy) is covered by
unit tests.

Usage:
  uv run python -m manual.mention_attachments
  uv run python -m manual.mention_attachments --base http://localhost:8000/api
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID

import httpx
from sqlmodel import col, select

from app.core.db import async_session_factory
from app.models.chat import SessionMessage

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
BIG_HEAD = "HEAD_MARKER_ALPHA"
BIG_TAIL = "TAIL_MARKER_OMEGA"
MIDDLE_MARKER = "Middle truncated"


def make_fixtures(root: Path) -> None:
    (root / "note.txt").write_text("hello from note.txt\n", encoding="utf-8")
    (root / "quoted.txt").write_text("inside quotes\n", encoding="utf-8")

    # ~80KB → above 32K mention cap → must be truncated head+tail.
    filler = "x" * 80_000
    big = f"{BIG_HEAD}\n{filler}\n{BIG_TAIL}\n"
    (root / "big.txt").write_text(big, encoding="utf-8")

    # 1x1 PNG.
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000a49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )
    (root / "photo.png").write_bytes(png)
    (root / "report.pdf").write_bytes(b"%PDF-1.4\n")
    (root / "spec.docx").write_bytes(b"PK\x03\x04fake")

    sub = root / "subdir"
    sub.mkdir()
    (sub / "inner.txt").write_text("inner\n", encoding="utf-8")
    (sub / "AGENTS.md").write_text("folder instructions\n", encoding="utf-8")


def post_chat(base: str, workspace: str, message: str) -> str:
    r = httpx.post(
        f"{base}/session/chat",
        data={"message": message, "mode": "coding", "workspace": workspace},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["session_id"]


def fetch_user_attachments(base: str, sid: str) -> tuple[list[dict], list[dict]]:
    """Read messages from the API history endpoint.

    Returns ``(user_messages, all_messages)`` — hidden synthetic rows are
    stripped by the API, so user_messages contains only the real user turn.
    """
    r = httpx.get(f"{base}/session/{sid}/history", timeout=30)
    r.raise_for_status()
    messages = r.json()["session"]["messages"]
    users = [m for m in messages if m.get("role") == "user"]
    atts: list[dict] = []
    if users:
        atts = (users[0].get("extra") or {}).get("attachments") or []
    return list(atts), messages


async def fetch_synthetic_rows(sid: str) -> list[SessionMessage]:
    """Read hidden synthetic attachment rows directly from the DB."""
    async with async_session_factory() as db:
        rows = await db.exec(
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == UUID(sid))
            .where(col(SessionMessage.role) == "user")
            .where(
                col(SessionMessage.extra)["hidden_from_user"].as_boolean() == True  # noqa: E712
            )
            .order_by(col(SessionMessage.created_at).asc())
        )
        return list(rows.all())


def check(name: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    suffix = f" — {detail}" if detail else ""
    print(f"  [{tag}] {name}{suffix}")
    return ok


def main() -> int:
    p = argparse.ArgumentParser(description="Mention attachment smoke test")
    p.add_argument("--base", default=BASE)
    args = p.parse_args()
    base = args.base.rstrip("/")

    workspace = Path(tempfile.mkdtemp(prefix="mention-smoketest-"))
    print(f"workspace: {workspace}")
    try:
        make_fixtures(workspace)
        msg = (
            "Look at @note.txt and @big.txt and @photo.png and @report.pdf "
            "and @spec.docx and @subdir/ "
            'and also "@quoted.txt".'
        )
        sid = post_chat(base, str(workspace), msg)
        print(f"session : {sid}")

        # The user row is persisted before the LLM runs; a short wait is enough.
        time.sleep(2.0)

        atts, all_msgs = fetch_user_attachments(base, sid)
        by_name = {a.get("original_name") or a.get("filename"): a for a in atts}
        print(f"attached (API): {sorted(by_name)}")

        results = [
            check("note.txt attached", "note.txt" in by_name),
            check("big.txt attached", "big.txt" in by_name),
            check("quoted.txt attached (inside quotes)", "quoted.txt" in by_name),
            check("photo.png NOT attached", "photo.png" not in by_name),
            check("report.pdf NOT attached", "report.pdf" not in by_name),
            check("spec.docx NOT attached", "spec.docx" not in by_name),
            check("subdir/AGENTS.md attached", "subdir/AGENTS.md" in by_name),
            check("bare AGENTS.md label not used", "AGENTS.md" not in by_name),
        ]

        # Attachment metadata must not leak internal fields to the API.
        for att in atts:
            for bad_field in ("converted_text", "path", "workspace_path"):
                results.append(
                    check(
                        f"internal field '{bad_field}' not in API response for {att.get('original_name')}",
                        bad_field not in att,
                    )
                )

        # Synthetic hidden rows in the DB carry the actual fenced content.
        # The API hides them (hidden_from_user=True), so we query the DB directly.
        synthetic_rows = asyncio.run(fetch_synthetic_rows(sid))
        synthetic_contents = [r.content or "" for r in synthetic_rows]
        print(f"synthetic rows in DB: {len(synthetic_rows)}")
        for i, row in enumerate(synthetic_rows):
            snippet = (row.content or "")[:80].replace("\n", "\\n")
            print(f"  [{i}] {snippet!r}")

        # Expect one synthetic row per auto-attached text file
        # (note.txt, big.txt, quoted.txt, subdir/AGENTS.md = 4 text files)
        results.append(
            check(
                "synthetic rows count matches text attachment count",
                len(synthetic_rows)
                == sum(1 for a in atts if a.get("category") == "text"),
                f"got {len(synthetic_rows)} rows, {len(atts)} atts",
            )
        )

        # Synthetic rows must NOT appear in the API history response
        api_ids = {m.get("id") for m in all_msgs}
        synth_ids = {str(r.id) for r in synthetic_rows}
        results.append(
            check(
                "synthetic rows absent from API history",
                synth_ids.isdisjoint(api_ids),
                f"leaked: {synth_ids & api_ids}",
            )
        )

        # note.txt → fenced content in its synthetic row
        note_synthetic = next(
            (c for c in synthetic_contents if "[File: note.txt]" in c), ""
        )
        results.append(
            check(
                "note.txt synthetic row has opening fence",
                "[File: note.txt]" in note_synthetic,
            )
        )
        results.append(
            check(
                "note.txt synthetic row has closing fence",
                "[End file: note.txt]" in note_synthetic,
            )
        )
        results.append(
            check(
                "note.txt content present in synthetic row",
                "hello from note.txt" in note_synthetic,
            )
        )

        # big.txt → head/tail truncation in its synthetic row
        big_synthetic = next(
            (c for c in synthetic_contents if "[File: big.txt]" in c), ""
        )
        results.append(
            check("big.txt head preserved in synthetic", BIG_HEAD in big_synthetic)
        )
        results.append(
            check("big.txt tail preserved in synthetic", BIG_TAIL in big_synthetic)
        )
        results.append(
            check(
                "big.txt truncated in synthetic",
                MIDDLE_MARKER in big_synthetic and len(big_synthetic) < 60_000,
                f"len={len(big_synthetic)}",
            )
        )

        ok = all(results)
        print(f"\n{'OK' if ok else 'FAIL'} ({sum(results)}/{len(results)})")
        return 0 if ok else 1
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())

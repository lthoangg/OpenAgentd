"""Smoke-test write-once synthetic attachment rows.

Runs against a live dev server and uses direct DB queries for internal state.

Checks:
  * explicit text upload keeps UI metadata on the real user row
  * synthetic attachment row is hidden from UI + summariser, visible to LLM
  * file content is present only in the hidden synthetic row
  * public API attachment metadata does not leak internal fields
  * LLM context loading includes the synthetic row

Usage:
  uv run python -m manual.attachment_synthetic_rows
  uv run python -m manual.attachment_synthetic_rows --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from uuid import UUID

import httpx
from sqlmodel import col, select

from app.core.db import async_session_factory
from app.models.chat import SessionMessage
from app.services.chat_service import get_messages_for_llm
from manual._common import DEFAULT_BASE, require_dev_server

MESSAGE = "Please read the attached smoke note."
FILENAME = "synthetic_smoke.txt"
PAYLOAD = "SYNTHETIC_ROW_SMOKE_PAYLOAD: durable hidden row content."
INTERNAL_FIELDS = {"converted_text", "path", "workspace_path"}


def _check(label: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    suffix = f" — {detail}" if detail else ""
    print(f"  [{tag}] {label}{suffix}")
    return ok


def _post_upload(base: str) -> str:
    r = httpx.post(
        f"{base}/session/chat",
        data={"message": MESSAGE},
        files={"files": (FILENAME, PAYLOAD.encode(), "text/plain")},
        timeout=30,
    )
    r.raise_for_status()
    return str(r.json()["session_id"])


def _history_messages(base: str, sid: str) -> list[dict]:
    r = httpx.get(f"{base}/session/{sid}/history", params={"limit": 1000}, timeout=20)
    r.raise_for_status()
    return list(r.json()["session"]["messages"])


async def _db_rows(
    sid: str,
) -> tuple[SessionMessage | None, list[SessionMessage], list]:
    async with async_session_factory() as db:
        rows = await db.exec(
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == UUID(sid))
            .where(col(SessionMessage.role) == "user")
            .order_by(col(SessionMessage.created_at).asc())
        )
        user_rows = list(rows.all())
        real = next(
            (
                row
                for row in user_rows
                if not (row.extra or {}).get("attachment_for_message_id")
                and row.content == MESSAGE
            ),
            None,
        )
        synthetics = [
            row
            for row in user_rows
            if (row.extra or {}).get("attachment_for_message_id")
        ]
        llm_messages = await get_messages_for_llm(db, UUID(sid))
        return real, synthetics, llm_messages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=DEFAULT_BASE)
    args = parser.parse_args()
    base = str(args.base).rstrip("/")
    require_dev_server(base)

    print(f"Posting attachment to {base} ...")
    sid = _post_upload(base)
    print(f"Session: {sid}")

    messages = _history_messages(base, sid)
    real_row, synthetic_rows, llm_messages = asyncio.run(_db_rows(sid))

    ok = True
    visible_users = [m for m in messages if m.get("role") == "user"]
    ok &= _check(
        "API hides synthetic rows",
        len(visible_users) == 1,
        f"visible user rows={len(visible_users)}",
    )
    user_extra = (visible_users[0].get("extra") or {}) if visible_users else {}
    api_atts = list(user_extra.get("attachments") or [])
    ok &= _check("API keeps one UI attachment meta", len(api_atts) == 1, str(api_atts))
    leaked = sorted(INTERNAL_FIELDS.intersection(api_atts[0])) if api_atts else []
    ok &= _check(
        "API strips internal attachment fields", not leaked, f"leaked={leaked}"
    )
    ok &= _check(
        "API user bubble content has no file body",
        PAYLOAD not in (visible_users[0].get("content") if visible_users else ""),
    )

    ok &= _check("DB real user row exists", real_row is not None)
    real_extra = real_row.extra if real_row is not None else {}
    db_atts = list((real_extra or {}).get("attachments") or [])
    ok &= _check(
        "DB real row keeps attachment metadata", len(db_atts) == 1, str(db_atts)
    )
    ok &= _check(
        "DB real row keeps internal path for cleanup",
        bool(db_atts and db_atts[0].get("path")),
    )

    ok &= _check(
        "DB has one synthetic row",
        len(synthetic_rows) == 1,
        f"count={len(synthetic_rows)}",
    )
    synthetic = synthetic_rows[0] if synthetic_rows else None
    sextra = synthetic.extra if synthetic is not None else {}
    ok &= _check(
        "synthetic hidden_from_user", bool((sextra or {}).get("hidden_from_user"))
    )
    ok &= _check(
        "synthetic hidden_from_summary", bool((sextra or {}).get("hidden_from_summary"))
    )
    ok &= _check(
        "synthetic visible to LLM context",
        synthetic is not None and synthetic.exclude_from_context is False,
    )
    ok &= _check(
        "synthetic links to parent user row",
        real_row is not None
        and (sextra or {}).get("attachment_for_message_id") == str(real_row.id),
    )
    content = synthetic.content if synthetic is not None else ""
    ok &= _check(
        "synthetic contains fenced file content",
        "[File: synthetic_smoke.txt]" in content and PAYLOAD in content,
    )

    llm_texts = [getattr(msg, "content", "") for msg in llm_messages]
    ok &= _check(
        "LLM context includes synthetic payload",
        any(PAYLOAD in text for text in llm_texts),
    )

    if ok:
        print("attachment synthetic row smoke passed")
        return 0
    print("attachment synthetic row smoke failed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

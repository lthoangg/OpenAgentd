"""``/api/terminal`` — interactive PTY terminal over WebSocket.

Auth model (two layers):

1. **HTTP ticket issuance** — ``POST /api/terminal/ticket`` sits behind
   the normal HTTP auth (``DesktopTokenMiddleware``: desktop token or
   LAN access key when configured). It validates the workspace and
   returns a short-lived, single-use ticket.
2. **WS connect** — ``GET /api/terminal/ws?ticket=…`` upgrades to a
   WebSocket. Browsers can't attach ``Authorization`` headers to WS
   handshakes, so the ticket (never the long-lived token) rides the
   URL. Tickets expire in seconds and burn on first use, so a leaked
   URL from a log is worthless. ``DesktopTokenMiddleware`` additionally
   enforces the ``?_token=`` rule on all ``/api/*`` WS upgrades as
   defence in depth; the frontend appends both.

Wire protocol (JSON text frames):

    client → server: {"type": "input",  "data": "<utf-8 keystrokes>"}
                     {"type": "resize", "rows": N, "cols": N}
    server → client: {"type": "output", "data": "<utf-8 chunk>"}
                     {"type": "exit"}

The PTY runs **on the backend host** — for external/LAN servers that is
the remote machine, not the client. UI copy must make this clear.
"""

from __future__ import annotations

import asyncio
import codecs
import hmac
import secrets
import time
import uuid

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel, Field, model_validator

from app.core.paths import workspace_dir
from app.services import team_manager, terminal_service

router = APIRouter()


def _new_decoder() -> codecs.IncrementalDecoder:
    """A fresh stream-aware UTF-8 decoder for one WS connection's output.

    ``bytes.decode("utf-8", errors="replace")`` on each PTY read chunk
    independently is wrong: a multibyte character (any non-ASCII glyph —
    box-drawing, emoji, p10k's powerline separators) can straddle two
    ``os.read()`` calls, and decoding each half in isolation corrupts it
    into U+FFFD even though the concatenated bytes are perfectly valid.
    ``codecs.getincrementaldecoder`` buffers a trailing partial sequence
    and completes it on the next ``decode()`` call instead.
    """
    return codecs.getincrementaldecoder("utf-8")(errors="replace")


# ── Ticket store ─────────────────────────────────────────────────────────────

#: ticket → (validated_workspace, expiry_monotonic, rows, cols). Single-use;
#: popped on first WS connect attempt. Module-level like other in-process
#: registries (mirrors ``terminal_service._SESSIONS``). rows/cols ride the
#: ticket so the PTY is spawned at the client's actual terminal size
#: instead of a 24x80 default that visibly reflows the instant the first
#: client resize frame arrives.
_TICKETS: dict[str, tuple[str, float, int, int]] = {}

TICKET_TTL_SECONDS = 30.0
_MAX_PENDING_TICKETS = 32


class TicketRequest(BaseModel):
    """Exactly one cwd source: a coding workspace path OR a chat session id.

    - ``workspace`` (coding mode): client-supplied absolute path, validated
      through ``team_manager.validate_workspace`` (must exist, blocklisted
      system roots rejected).
    - ``session_id`` (cockpit mode): UUID only — the server derives the
      path from ``OPENAGENTD_WORKSPACE_DIR``, so no client-controlled path
      ever reaches the filesystem. Created lazily (the sandbox dir may not
      exist until an agent first writes to it).
    """

    workspace: str | None = Field(default=None, min_length=1)
    session_id: str | None = None
    rows: int = Field(default=24, ge=1, le=1000)
    cols: int = Field(default=80, ge=1, le=4000)

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "TicketRequest":
        if (self.workspace is None) == (self.session_id is None):
            raise ValueError("Provide exactly one of 'workspace' or 'session_id'.")
        if self.session_id is not None:
            try:
                uuid.UUID(self.session_id)
            except ValueError as exc:
                raise ValueError("session_id must be a UUID") from exc
        return self


class TicketResponse(BaseModel):
    ticket: str
    expires_in: float


def _prune_expired_tickets() -> None:
    now = time.monotonic()
    for ticket, (_ws, expiry, _rows, _cols) in list(_TICKETS.items()):
        if now > expiry:
            del _TICKETS[ticket]


@router.post("/ticket", response_model=TicketResponse)
async def issue_ticket(body: TicketRequest) -> TicketResponse:
    """Resolve the cwd source and mint a single-use WS connect ticket."""
    if body.workspace is not None:
        try:
            resolved = team_manager.validate_workspace(body.workspace)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        # Server-derived path — session_id is UUID-validated by the model,
        # so no client-controlled path component reaches the filesystem.
        assert body.session_id is not None  # guaranteed by _exactly_one_source
        root = workspace_dir(body.session_id)
        root.mkdir(parents=True, exist_ok=True)
        resolved = str(root)

    _prune_expired_tickets()
    if len(_TICKETS) >= _MAX_PENDING_TICKETS:
        raise HTTPException(status_code=429, detail="Too many pending tickets.")

    ticket = secrets.token_urlsafe(32)
    _TICKETS[ticket] = (
        resolved,
        time.monotonic() + TICKET_TTL_SECONDS,
        body.rows,
        body.cols,
    )
    return TicketResponse(ticket=ticket, expires_in=TICKET_TTL_SECONDS)


class _RedeemedTicket(BaseModel):
    workspace: str
    rows: int
    cols: int


def _redeem_ticket(ticket: str) -> _RedeemedTicket | None:
    """Pop and return the workspace/size for *ticket* if valid, else None.

    Constant-time lookup: compare against all stored tickets so a
    timing probe cannot distinguish "unknown" from "known" tickets.
    """
    _prune_expired_tickets()
    matched: str | None = None
    for stored in _TICKETS:
        if hmac.compare_digest(stored, ticket):
            matched = stored
    if matched is None:
        return None
    workspace, expiry, rows, cols = _TICKETS.pop(matched)
    if time.monotonic() > expiry:
        return None
    return _RedeemedTicket(workspace=workspace, rows=rows, cols=cols)


# ── WebSocket ────────────────────────────────────────────────────────────────


@router.websocket("/ws")
async def terminal_ws(websocket: WebSocket) -> None:
    ticket = websocket.query_params.get("ticket", "")
    redeemed = _redeem_ticket(ticket) if ticket else None
    if redeemed is None:
        # Deny before accept → handshake fails with 403.
        await websocket.close(code=4401)
        return

    await websocket.accept()

    try:
        session = await terminal_service.create_session(
            workspace=redeemed.workspace, rows=redeemed.rows, cols=redeemed.cols
        )
    except (RuntimeError, OSError) as exc:
        # RuntimeError: MAX_SESSIONS cap (expected, user-actionable).
        # OSError: real spawn failure — e.g. the host's PTY table is
        # exhausted (``pty.openpty()`` raises "out of pty devices") or
        # exec of the shell binary failed. Both are terminal-session-only
        # failures, not ASGI/server bugs — report and close the socket
        # rather than letting the exception propagate and crash the
        # connection handler.
        logger.warning(
            "terminal_spawn_failed workspace={} err={}", redeemed.workspace, exc
        )
        await websocket.send_json({"type": "output", "data": f"\r\n{exc}\r\n"})
        await websocket.close(code=4429)
        return

    logger.info(
        "terminal_ws_connected session_id={} workspace={}",
        session.session_id,
        redeemed.workspace,
    )

    async def pty_to_ws() -> None:
        decoder = _new_decoder()
        while True:
            chunk = await session.read()
            if chunk is None:
                # Flush any partial sequence left buffered in the decoder
                # (a truncated multibyte tail at EOF) before signalling exit.
                tail = decoder.decode(b"", final=True)
                if tail:
                    await websocket.send_json({"type": "output", "data": tail})
                await websocket.send_json({"type": "exit"})
                return
            await websocket.send_json({"type": "output", "data": decoder.decode(chunk)})

    async def ws_to_pty() -> None:
        while True:
            msg = await websocket.receive_json()
            match msg.get("type"):
                case "input":
                    data = msg.get("data", "")
                    if isinstance(data, str) and data:
                        await session.write(data.encode("utf-8"))
                case "resize":
                    rows, cols = msg.get("rows"), msg.get("cols")
                    if isinstance(rows, int) and isinstance(cols, int):
                        session.resize(rows=rows, cols=cols)

    to_ws = asyncio.create_task(pty_to_ws())
    to_pty = asyncio.create_task(ws_to_pty())
    try:
        done, pending = await asyncio.wait(
            {to_ws, to_pty}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(
                exc, (WebSocketDisconnect, asyncio.CancelledError)
            ):
                logger.warning(
                    "terminal_ws_error session_id={} err={}", session.session_id, exc
                )
    except WebSocketDisconnect:
        pass
    finally:
        to_ws.cancel()
        to_pty.cancel()
        await session.close()
        try:
            await websocket.close()
        except Exception as exc:
            # Socket may already be closed by the client — nothing to do.
            logger.debug("terminal_ws_close_failed error={!r}", exc)

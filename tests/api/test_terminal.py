"""Tests for /api/terminal — ticket issuance and the PTY WebSocket."""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.routes.terminal import router as terminal_router, _TICKETS, _new_decoder
from app.services.terminal_service import close_all


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()
    app.include_router(terminal_router, prefix="/api/terminal")
    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_state():
    _TICKETS.clear()
    yield
    _TICKETS.clear()
    # Close PTYs synchronously via a fresh loop — tests run sync TestClient.
    import asyncio

    asyncio.run(close_all())


class TestTicket:
    def test_issue_ticket(self, client, tmp_path):
        r = client.post("/api/terminal/ticket", json={"workspace": str(tmp_path)})
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body["ticket"], str) and len(body["ticket"]) >= 32
        assert body["expires_in"] > 0

    def test_ticket_requires_valid_workspace(self, client):
        r = client.post("/api/terminal/ticket", json={"workspace": "/nonexistent/nope"})
        assert r.status_code == 400

    def test_ticket_rejects_restricted_workspace(self, client):
        r = client.post("/api/terminal/ticket", json={"workspace": "/etc"})
        assert r.status_code == 400


class TestTicketHonorsInitialSize:
    """The ticket carries the client's rows/cols so the very first PTY
    spawn is sized correctly — without this, every terminal starts at
    the 24x80 default and visibly reflows the instant the client's first
    resize frame arrives (jarring with prompts like p10k that lay out
    based on terminal width)."""

    def test_ticket_size_is_used_for_initial_spawn(self, client, tmp_path):
        r = client.post(
            "/api/terminal/ticket",
            json={"workspace": str(tmp_path), "rows": 50, "cols": 137},
        )
        assert r.status_code == 200
        ticket = r.json()["ticket"]
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            ws.send_json({"type": "input", "data": "stty size\n"})
            buf = ""
            for _ in range(50):
                msg = ws.receive_json()
                if msg["type"] == "output":
                    buf += msg["data"]
                if "50 137" in buf:
                    break
            assert "50 137" in buf


class TestIncrementalDecoder:
    """The PTY→WS path must decode with a stream-aware incremental
    decoder, not a fresh ``bytes.decode(errors="replace")`` per chunk —
    a multibyte UTF-8 character can straddle two separate ``os.read()``
    calls, and independently decoding each half corrupts it into
    replacement characters even though the concatenated bytes are valid.
    """

    def test_split_multibyte_sequence_decodes_correctly_across_chunks(self):
        decoder = _new_decoder()
        phrase = "日本語テスト🎉"
        raw = phrase.encode("utf-8")
        # Split in the middle of a multibyte sequence (byte 4 lands inside
        # the second character's 3-byte encoding).
        split_at = 4
        first = decoder.decode(raw[:split_at])
        second = decoder.decode(raw[split_at:])
        assert first + second == phrase

    def test_invalid_trailing_bytes_are_replaced_not_raised(self):
        decoder = _new_decoder()
        # A lone continuation byte can never become valid — must degrade
        # to U+FFFD rather than raising and killing the read loop.
        out = decoder.decode(b"\xff\xfe")
        assert "\ufffd" in out


class TestWebSocket:
    def _ticket(self, client, tmp_path) -> str:
        r = client.post("/api/terminal/ticket", json={"workspace": str(tmp_path)})
        assert r.status_code == 200
        return r.json()["ticket"]

    def test_ws_without_ticket_rejected(self, client):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/terminal/ws"):
                pass

    def test_ws_with_bogus_ticket_rejected(self, client):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/terminal/ws?ticket=bogus"):
                pass

    def test_ws_spawn_os_error_closes_gracefully(self, client, tmp_path, monkeypatch):
        """A real spawn failure (PTY table exhausted, exec failure, ...)
        raises OSError from create_session() — this must be handled the
        same way the RuntimeError/"too many sessions" case already is
        (send an error frame, close with 4429), not propagate and crash
        the ASGI connection handler."""

        async def _boom(**_kwargs):
            raise OSError("out of pty devices")

        monkeypatch.setattr(
            "app.api.routes.terminal.terminal_service.create_session", _boom
        )
        ticket = self._ticket(client, tmp_path)
        # The WS handshake itself succeeds (ticket was valid, accept()
        # already happened) — the failure surfaces as an error frame
        # followed by the server closing the socket, not a handshake
        # rejection. Assert both: the message reaches the client, and
        # the socket is subsequently closed (not left half-open/crashed).
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "output"
            assert "out of pty devices" in msg["data"]
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

    def test_ws_ticket_single_use(self, client, tmp_path):
        ticket = self._ticket(client, tmp_path)
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}"):
            pass  # first use OK
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}"):
                pass  # burned

    def test_ws_expired_ticket_rejected(self, client, tmp_path):
        ticket = self._ticket(client, tmp_path)
        # Force-expire.
        stored = _TICKETS[ticket]
        _TICKETS[ticket] = (stored[0], time.monotonic() - 1, stored[2], stored[3])
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}"):
                pass

    def test_ws_echo_round_trip(self, client, tmp_path):
        ticket = self._ticket(client, tmp_path)
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            ws.send_json({"type": "input", "data": "echo term_$((40+2))\n"})
            buf = ""
            for _ in range(50):
                msg = ws.receive_json()
                if msg["type"] == "output":
                    buf += msg["data"]
                if "term_42" in buf:
                    break
            assert "term_42" in buf

    def test_ws_resize_frame(self, client, tmp_path):
        ticket = self._ticket(client, tmp_path)
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            ws.send_json({"type": "resize", "rows": 40, "cols": 100})
            ws.send_json({"type": "input", "data": "stty size\n"})
            buf = ""
            for _ in range(50):
                msg = ws.receive_json()
                if msg["type"] == "output":
                    buf += msg["data"]
                if "40 100" in buf:
                    break
            assert "40 100" in buf

    def test_ws_multibyte_output_survives_pty_chunk_boundaries(self, client, tmp_path):
        """Regression test for the per-chunk-decode corruption bug: this
        streams enough multibyte text that a real PTY will very likely
        deliver it across more than one ``os.read()`` — proving the fix
        works end-to-end over the actual WS wire, not just at the unit
        level of ``_new_decoder`` in isolation.

        Uses ``cat`` on a pre-written file rather than a typed command
        line: an interactive shell's own line editor (e.g.
        zsh-syntax-highlighting) redraws typed input through its own
        buffering, which is a shell-input-editing concern unrelated to
        what's under test here — decoding of *PTY output* bytes as they
        arrive from the kernel in arbitrary chunk boundaries.
        """
        ticket = self._ticket(client, tmp_path)
        emoji = "🎉"
        repeat = 50
        phrase = f"日本語テスト{emoji}" * repeat
        (tmp_path / "phrase.txt").write_text(phrase, encoding="utf-8")
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            ws.send_json({"type": "input", "data": "cat phrase.txt\n"})
            buf = ""
            for _ in range(200):
                msg = ws.receive_json()
                if msg["type"] == "output":
                    buf += msg["data"]
                if buf.count(emoji) >= repeat:
                    break
            assert "\ufffd" not in buf
            assert buf.count(emoji) == repeat

    def test_ws_exit_closes_stream(self, client, tmp_path):
        ticket = self._ticket(client, tmp_path)
        with client.websocket_connect(f"/api/terminal/ws?ticket={ticket}") as ws:
            ws.send_json({"type": "input", "data": "exit\n"})
            saw_exit = False
            for _ in range(100):
                try:
                    msg = ws.receive_json()
                except WebSocketDisconnect:
                    saw_exit = True
                    break
                if msg["type"] == "exit":
                    saw_exit = True
                    break
            assert saw_exit

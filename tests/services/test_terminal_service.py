"""Tests for app/services/terminal_service.py — PTY session lifecycle.

These tests spawn real PTYs running ``/bin/sh`` (POSIX-guaranteed) with a
minimal env, so they are fast and deterministic. The real PTY lifecycle tests
run on macOS/Linux; Windows coverage verifies the explicit ConPTY limitation.
"""

from __future__ import annotations

import asyncio
import threading
import warnings

import pytest

from app.services import terminal_service
from app.services.terminal_service import (
    MAX_SESSIONS,
    TerminalSession,
    close_all,
    create_session,
    get_session,
)


@pytest.fixture(autouse=True)
async def _clean_registry():
    """Every test starts and ends with an empty session registry."""
    await close_all()
    yield
    await close_all()


async def _read_until(
    session: TerminalSession, needle: bytes, timeout: float = 5.0
) -> bytes:
    """Drain session output until *needle* appears or timeout."""
    buf = b""
    async with asyncio.timeout(timeout):
        while needle not in buf:
            chunk = await session.read()
            if chunk is None:  # EOF
                break
            buf += chunk
    return buf


class TestCreateSession:
    async def test_windows_reports_conpty_limitation(self, monkeypatch, tmp_path):
        monkeypatch.setattr(terminal_service.os, "name", "nt")

        with pytest.raises(RuntimeError, match="not available on Windows"):
            await create_session(workspace=str(tmp_path))

    async def test_spawns_shell_in_workspace(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        try:
            # `pwd` should print the workspace dir (resolve() both sides:
            # macOS /tmp is a symlink to /private/tmp).
            await session.write(b"pwd\n")
            out = await _read_until(session, str(tmp_path.resolve()).encode())
            assert str(tmp_path.resolve()).encode() in out
        finally:
            await session.close()

    async def test_session_registered_and_retrievable(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        assert get_session(session.session_id) is session

    async def test_get_unknown_session_returns_none(self):
        assert get_session("nope") is None

    async def test_concurrent_session_cap(self, tmp_path):
        sessions = [
            await create_session(workspace=str(tmp_path)) for _ in range(MAX_SESSIONS)
        ]
        try:
            with pytest.raises(RuntimeError, match="[Tt]oo many"):
                await create_session(workspace=str(tmp_path))
        finally:
            for s in sessions:
                await s.close()


class TestIO:
    async def test_echo_round_trip(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        try:
            await session.write(b"echo terminal_$((20+3))\n")
            out = await _read_until(session, b"terminal_23")
            assert b"terminal_23" in out
        finally:
            await session.close()

    async def test_resize_changes_pty_winsize(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        try:
            session.resize(rows=48, cols=120)
            await session.write(b"stty size\n")
            out = await _read_until(session, b"48 120")
            assert b"48 120" in out
        finally:
            await session.close()

    async def test_read_returns_none_after_shell_exit(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        try:
            await session.write(b"exit\n")
            async with asyncio.timeout(5):
                while True:
                    chunk = await session.read()
                    if chunk is None:
                        break
            assert not session.alive
        finally:
            await session.close()


class TestClose:
    async def test_close_kills_process_and_unregisters(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        sid = session.session_id
        await session.close()
        assert not session.alive
        assert get_session(sid) is None

    async def test_close_is_idempotent(self, tmp_path):
        session = await create_session(workspace=str(tmp_path))
        await session.close()
        await session.close()  # must not raise

    async def test_close_all(self, tmp_path):
        s1 = await create_session(workspace=str(tmp_path))
        s2 = await create_session(workspace=str(tmp_path))
        await close_all()
        assert get_session(s1.session_id) is None
        assert get_session(s2.session_id) is None
        assert not s1.alive and not s2.alive


class TestSessionEnvIsolation:
    """The spawned shell is a brand-new logical terminal session, not a
    continuation of whatever terminal happens to be running the backend
    process. Terminal.app-family env vars that identify *that* outer
    session must not leak in — on macOS, ``/etc/zshrc_Apple_Terminal``
    treats a matching ``TERM_SESSION_ID`` as "resume this session" and
    can print ``Restored session: <date>`` into the new PTY at an
    arbitrary point in the byte stream (observed interleaving with — and
    corrupting — real multibyte output in manual testing).
    """

    async def test_term_session_id_not_inherited(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TERM_SESSION_ID", "outer-terminal-session-id")
        session = await create_session(workspace=str(tmp_path))
        try:
            # Quoted expansion (not bracketed/glob-prone) so this can't be
            # confused with a zsh "no matches found" glob error — the
            # *echoed input line* contains the literal, unexpanded
            # "$TERM_SESSION_ID" text; only the shell's actual command
            # *output* (read second, further down the stream) contains
            # the expanded value, which is what we're asserting on.
            await session.write(b'echo "MARKER_DONE_TAG=$TERM_SESSION_ID."\n')
            out = await _read_until(session, b"MARKER_DONE_TAG=.", timeout=8.0)
            assert b"outer-terminal-session-id" not in out
            assert b"Restored session" not in out
        finally:
            await session.close()


class TestForkSafety:
    """create_session() must not use raw fork()/pty.fork() while the
    process is multi-threaded — CPython 3.12+ emits a DeprecationWarning
    ("this process is multi-threaded, use of forkpty() may lead to
    deadlocks in the child") for exactly that pattern, and the server
    always has background threads running (OTel exporters, jsonl
    writers) by the time a terminal is opened.
    """

    async def test_no_fork_deprecation_warning_with_background_threads(self, tmp_path):
        spin_done = threading.Event()

        def _spin() -> None:
            spin_done.wait(2.0)

        t = threading.Thread(target=_spin, daemon=True)
        t.start()
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                session = await create_session(workspace=str(tmp_path))
                await session.close()
            fork_warnings = [
                w
                for w in caught
                if issubclass(w.category, DeprecationWarning)
                and "multi-threaded" in str(w.message)
            ]
            assert not fork_warnings, [str(w.message) for w in fork_warnings]
        finally:
            spin_done.set()
            t.join(timeout=2)


class TestJobControl:
    async def test_ctrl_c_interrupts_foreground_process(self, tmp_path):
        """Ctrl+C (0x03) must reach the shell's foreground process group
        as SIGINT — this is what makes a real interactive terminal usable
        (killing a hung command, breaking out of a REPL). Proof: a 30s
        sleep is started, interrupted, and the shell accepts a *new*
        command well before the sleep's natural duration would elapse —
        if SIGINT were swallowed, the echo below would only appear after
        the full 30s sleep completed.
        """
        session = await create_session(workspace=str(tmp_path))
        try:
            await session.write(b"sleep 30\n")
            # Wait for the shell to actually echo the command (rather than
            # a fixed sleep) before interrupting — a loaded CI box can be
            # slow enough that a blind 0.3s isn't always past the echo.
            await _read_until(session, b"sleep 30", timeout=5.0)
            await asyncio.sleep(0.2)
            await session.write(b"\x03")
            await session.write(b"echo INTERRUPT_OK_$((40+2))\n")
            out = await _read_until(session, b"INTERRUPT_OK_42", timeout=10.0)
            assert b"INTERRUPT_OK_42" in out
        finally:
            await session.close()


class TestIdleReaping:
    async def test_idle_session_reaped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(terminal_service, "IDLE_TIMEOUT_SECONDS", 0.2)
        session = await create_session(workspace=str(tmp_path))
        sid = session.session_id
        # No I/O for > timeout → reaper closes it.
        async with asyncio.timeout(5):
            while get_session(sid) is not None:
                await asyncio.sleep(0.1)
        assert not session.alive

    async def test_active_session_not_reaped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(terminal_service, "IDLE_TIMEOUT_SECONDS", 0.5)
        session = await create_session(workspace=str(tmp_path))
        try:
            for _ in range(4):
                await asyncio.sleep(0.25)
                await session.write(b"\n")  # keep-alive activity
            assert get_session(session.session_id) is session
            assert session.alive
        finally:
            await session.close()

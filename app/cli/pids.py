"""PID file helpers: write/read/find running openagentd processes."""

from __future__ import annotations

import os

from app.cli.paths import _pid_file


def _write_pids(pids: list[int]) -> None:
    pid_file = _pid_file()
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text("\n".join(str(p) for p in pids))


def _read_pids() -> list[int]:
    pid_file = _pid_file()
    if not pid_file.exists():
        return []
    try:
        return [int(line) for line in pid_file.read_text().splitlines() if line.strip()]
    except ValueError:
        return []


def _windows_pid_alive(pid: int) -> bool:
    """Return whether a Windows process still runs without signalling it."""
    import ctypes
    from ctypes import wintypes

    if pid <= 0:
        return False

    process_query_limited_information = 0x1000
    still_active = 259
    error_access_denied = 5
    kernel32 = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return getattr(ctypes, "get_last_error")() == error_access_denied
    try:
        exit_code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and (
            exit_code.value == still_active
        )
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _find_pids() -> list[int]:
    """Find running PIDs, filtered to those still alive."""
    return [p for p in _read_pids() if _pid_alive(p)]


def _clear_pids() -> None:
    _pid_file().unlink(missing_ok=True)

"""Shell binary selection — honours the user's $SHELL with safety guardrails.

Mirrors the design of opencode's ``shell.ts``:

- Reads ``$SHELL`` from the environment.
- Rejects incompatible shells (``fish``, ``nu``) that do not speak
  POSIX syntax — agents produce POSIX commands so incompatible shells
  would misinterpret them.
- Falls back through ``zsh`` → ``bash`` → ``sh`` on POSIX, or ``pwsh`` →
  Windows PowerShell → ``cmd.exe`` on Windows.
- Exposes ``preferred()`` (exact user preference, may be None) and
  ``acceptable()`` (always non-None, safe to pass to subprocess).

Both are lazy ``functools.cached_property``-style singletons — detected once
per process, cached forever.  Tests can override by patching
``app.agent.tools.builtin.shell_runtime._CACHED_SHELL``.
"""

from __future__ import annotations

import os
import ntpath
import shutil
import sys
from pathlib import Path

# ── Shell name sets ──────────────────────────────────────────────────────────

# Shells that do not understand POSIX syntax; agents generate POSIX commands
# so we must never dispatch to these.
BLACKLIST: frozenset[str] = frozenset({"fish", "nu", "nushell"})

# POSIX-compatible shells — ordered by preference (best first)
_POSIX_FALLBACKS: tuple[str, ...] = ("zsh", "bash", "sh")


# ── Internal helpers ─────────────────────────────────────────────────────────


def _shell_name(path: str) -> str:
    """Return the lowercase basename of a shell path (no extension on any OS)."""
    basename = ntpath.basename(path) if "\\" in path else Path(path).name
    stem = Path(basename).stem.lower()
    return stem


def _which(name: str) -> str | None:
    """Return the full path to *name* if it is on PATH, else None."""
    return shutil.which(name)


def _is_usable(path: str) -> bool:
    """True if *path* is a non-blacklisted, executable shell."""
    name = _shell_name(path)
    if name in BLACKLIST:
        return False
    # Must exist and be executable (shutil.which already guarantees this for
    # names; for absolute paths we verify directly).
    if os.path.isabs(path):
        return os.access(path, os.X_OK)
    return _which(path) is not None


def _fallback() -> str:
    """Return the best available command shell on this machine."""
    if sys.platform == "win32":
        for name in ("pwsh", "powershell", "cmd"):
            found = _which(name)
            if found:
                return found
        return "cmd.exe"
    # macOS always ships /bin/zsh since Catalina
    if sys.platform == "darwin":
        return "/bin/zsh"
    for name in _POSIX_FALLBACKS:
        found = _which(name)
        if found:
            return found
    return "/bin/sh"  # POSIX guarantee — always present


# ── Module-level detection cache ────────────────────────────────────────────
# Mutate ``_CACHED_SHELL`` in tests to override detection without environment
# manipulation.

_CACHED_SHELL: str | None = None  # sentinel — populated on first use


def _detect() -> str:
    """Detect the best shell, caching the result in ``_CACHED_SHELL``.

    Detection order:
    1. ``$SHELL`` environment variable, if set and acceptable.
    2. ``/bin/zsh`` on macOS (default since Catalina).
    3. First of ``zsh``, ``bash``, ``sh`` found on PATH.
    4. ``/bin/sh`` (POSIX guarantee).
    """
    global _CACHED_SHELL
    if _CACHED_SHELL is not None:
        return _CACHED_SHELL

    # ``SHELL`` is a POSIX convention and is frequently inherited on Windows
    # from Git Bash, MSYS, or development tooling. Native desktop commands
    # must not accidentally select a Unix compatibility layer.
    if sys.platform == "win32":
        _CACHED_SHELL = _fallback()
        return _CACHED_SHELL

    env_shell = os.environ.get("SHELL", "")
    if env_shell and _is_usable(env_shell):
        _CACHED_SHELL = env_shell
        return _CACHED_SHELL

    # env_shell was blacklisted (e.g. fish) or empty — pick a POSIX fallback
    _CACHED_SHELL = _fallback()
    return _CACHED_SHELL


# ── Public API ───────────────────────────────────────────────────────────────


def acceptable() -> str:
    """Return the shell binary path to use for subprocess execution.

    Always returns a non-None, executable, POSIX-compatible path.
    """
    return _detect()


def name(shell_path: str | None = None) -> str:
    """Return the lowercase name of a shell (basename without extension).

    If *shell_path* is None, uses :func:`acceptable` to get the current shell.
    """
    return _shell_name(shell_path or acceptable())


# ── argv construction ───────────────────────────────────────────────────────
# Mirrors opencode's ``shell.ts`` (packages/opencode/src/shell/shell.ts).
#
# When a GUI app (or any non-interactive context) launches the daemon, its
# PATH only contains system defaults — user dirs like ``~/.local/bin``,
# ``~/.bun/bin``, ``~/.cargo/bin``, and ``$(brew --prefix)/bin`` are missing
# because they are added by interactive rc files (``~/.zshrc``, ``~/.bashrc``).
# A plain ``zsh -c`` does NOT source those files, so the agent cannot find
# tools the user installed.
#
# Fix: invoke the shell with ``-l`` (login) AND explicitly source the
# interactive rc files.  Errors during sourcing are swallowed so a broken
# rc never blocks a command.  Other POSIX shells (sh/dash/ksh) fall back
# to bare ``-c`` — they have no widely-used per-user rc file.


def build_argv(shell_bin: str, command: str) -> list[str]:
    """Return argv (after the shell binary) that runs *command* with full user PATH.

    For zsh/bash we wrap *command* in a small script that sources the user's
    rc files before evaluating it.  For other POSIX shells we use a bare
    ``-c`` since they have no portable per-user rc convention.

    The shell's ``cwd`` is set by the caller via ``subprocess`` ``cwd=`` —
    we don't ``cd`` inside the script so a missing workdir raises a clear
    OS-level error instead of an opaque shell error.
    """
    shell_name = _shell_name(shell_bin)

    if shell_name in {"pwsh", "powershell"}:
        return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]

    if shell_name == "cmd":
        return ["/d", "/s", "/c", command]

    if shell_name == "zsh":
        # -l loads ~/.zprofile/~/.zlogin; explicit source covers ~/.zshenv
        # and ~/.zshrc which a non-interactive login shell skips.
        # ``eval $1`` keeps quoting/$VAR semantics identical to ``zsh -c``.
        # History isolation: a non-interactive ``zsh -c`` never triggers zsh's
        # own history-save-on-exit path, but a user's ~/.zshrc may load a
        # history plugin (atuin, zsh-histdb, custom preexec/precmd hooks)
        # that writes unconditionally rather than gating on ``[[ -o interactive ]]``.
        # Force HISTFILE off *after* sourcing rc (so PATH/aliases from rc still
        # apply) to guarantee agent-run commands never land in the user's real
        # shell history, regardless of what the rc file does.
        wrapper = (
            "[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true; "
            '[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && '
            'source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true; '
            "unset HISTFILE; HISTSIZE=0; SAVEHIST=0; "
            "unsetopt appendhistory incappendhistory sharehistory 2>/dev/null; "
            'eval "$1"'
        )
        return ["-l", "-c", wrapper, "openagentd", command]

    if shell_name == "bash":
        wrapper = (
            "shopt -s expand_aliases; "
            "[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true; "
            "unset HISTFILE; HISTSIZE=0; HISTFILESIZE=0; set +o history 2>/dev/null; "
            'eval "$1"'
        )
        return ["-l", "-c", wrapper, "openagentd", command]

    # sh, dash, ksh, anything else POSIX-compatible
    return ["-c", command]


def reset_cache() -> None:
    """Clear the cached shell detection — for test isolation only."""
    global _CACHED_SHELL
    _CACHED_SHELL = None

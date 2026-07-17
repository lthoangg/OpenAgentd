"""``openagentd doctor`` — health check for the install and environment.

Exits with code ``1`` if any check fails so the command is useful in CI
and post-install scripts. Warnings (degraded but bootable) keep the
exit code at ``0`` so doctor can run on a fresh install without the
``Web UI not bundled`` warning blocking automation.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
from pathlib import Path

from app.cli.commands.init import _PROVIDER_KEY_VAR
from app.cli.paths import _config_dir, _data_dir
from app.cli.ui import _bold, _cyan, _dim, _green, _red, _yellow

#: All provider env vars we recognise. Sourced from the canonical map in
#: ``init.py`` plus extras (``NINJA``, ``VERTEXAI``) that ``init`` doesn't
#: prompt for but the runtime accepts. Single source of truth: ``init``.
_LLM_API_KEY_VARS: tuple[str, ...] = (
    *_PROVIDER_KEY_VAR.values(),
    "NINJA_API_KEY",
    "VERTEXAI_API_KEY",
)

#: Providers that authenticate via OAuth or ADC — no API key required.
#: Doctor should not fail or warn when these are the configured provider.
#: ``ollama`` is here too: the local daemon ignores auth and the
#: settings layer ships a placeholder key by default.
_OAUTH_PROVIDERS: frozenset[str] = frozenset(
    {"copilot", "codex", "grok", "vertexai", "cliproxy", "router9", "ollama"}
)


def cmd_doctor(_args: argparse.Namespace) -> None:
    """Check system health, print a summary, and exit non-zero on errors."""
    passes = 0
    warnings = 0
    errors = 0

    def _ok(msg: str) -> None:
        nonlocal passes
        passes += 1
        print(f"  {_green('✓')}  {msg}")

    def _warn(msg: str) -> None:
        nonlocal warnings
        warnings += 1
        print(f"  {_yellow('⚠')}  {msg}")

    def _fail(msg: str) -> None:
        nonlocal errors
        errors += 1
        print(f"  {_red('✗')}  {msg}")

    print()
    print(f"  {_bold(_cyan('openagentd doctor'))}")
    print()

    # ── 1. Python version ───────────────────────────────────────────────────
    vi = sys.version_info
    ver_str = f"{vi.major}.{vi.minor}.{vi.micro}"
    if (vi.major, vi.minor) >= (3, 14):
        _ok(f"Python {ver_str}")
    else:
        _fail(f"Python {ver_str}  (need >= 3.14)")

    # ── 2. LLM provider API keys ────────────────────────────────────────────
    config_dir = _config_dir()

    configured_provider = _read_lead_provider(config_dir / "agents")
    found_keys: list[str] = [k for k in _LLM_API_KEY_VARS if os.environ.get(k)]
    uses_oauth = configured_provider in _OAUTH_PROVIDERS

    if found_keys:
        for key in found_keys:
            _ok(f"API key: {key}")
    elif uses_oauth:
        _ok(f"Provider '{configured_provider}' uses OAuth — no API key required")
    elif configured_provider is None:
        # Can't read agent file — agents check (below) will report the real issue.
        _warn("No agents configured — cannot verify provider credentials")
    else:
        _fail("No LLM provider API key configured")
        _dim_hint = _dim(f"  Set one of: {', '.join(_PROVIDER_KEY_VAR.values())}")
        print(f"     {_dim_hint}")

    # ── 3. Configured provider has matching key ─────────────────────────────
    # Parse the lead agent's `model:` line; if it names a provider that
    # has no matching key, surface a warning so users catch the mismatch
    # before chat returns 500.
    if configured_provider is not None:
        if uses_oauth:
            _ok(f"Provider '{configured_provider}' authenticated via OAuth")
        else:
            expected_key = _PROVIDER_KEY_VAR.get(configured_provider)
            if expected_key is None:
                # Unknown provider — could be a custom integration; warn.
                _warn(f"Lead agent uses unknown provider: {configured_provider}")
            elif expected_key in found_keys:
                _ok(f"Provider key matches lead agent: {expected_key}")
            else:
                _fail(
                    f"Lead agent uses '{configured_provider}' but {expected_key} is not set"
                )

    # ── 4. Database file ────────────────────────────────────────────────────
    data_dir = _data_dir()
    db_path = data_dir / "openagentd.db"
    display_db = str(db_path).replace(str(Path.home()), "~")
    if db_path.exists():
        _ok(f"Database: {display_db}")
    else:
        _warn(f"Database not found: {display_db}  (will be created on first run)")

    # ── 5. Alembic config reachable ─────────────────────────────────────────
    # Regression guard for the wheel-packaging bug fixed in commit de3a58a.
    # ``app/core/db.py`` looks for alembic.ini at ``Path(__file__).parent.parent``.
    from app.core import db as _db_module

    alembic_ini = Path(_db_module.__file__).parent.parent / "alembic.ini"
    if alembic_ini.is_file():
        _ok("Alembic config bundled")
    else:
        _fail(f"Alembic config missing: {alembic_ini}  (reinstall openagentd)")

    # ── 6. Default port availability ────────────────────────────────────────
    # Probe the production default. Users who pass ``--port`` know what
    # they're doing; this check only surfaces "is the box ready for the
    # vanilla `openagentd` command".
    default_port = 4082
    port_in_use = False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as _sock:
            _sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            _sock.bind(("127.0.0.1", default_port))
    except OSError:
        port_in_use = True

    if port_in_use:
        _warn(f"Port {default_port} in use  (server may already be running)")
    else:
        _ok(f"Port {default_port} available")

    # ── 7. Agents directory ─────────────────────────────────────────────────
    agents_dir = config_dir / "agents"
    display_agents = str(agents_dir).replace(str(Path.home()), "~")
    if agents_dir.is_dir() and any(agents_dir.glob("*.md")):
        _ok(f"Agents: {display_agents}")
    else:
        _fail(f"Agents not found: {display_agents}  (run: openagentd init)")

    # ── Summary ─────────────────────────────────────────────────────────────
    print()
    parts: list[str] = [_green(f"{passes} passed")]
    if warnings:
        parts.append(_yellow(f"{warnings} warning{'s' if warnings != 1 else ''}"))
    if errors:
        parts.append(_red(f"{errors} error{'s' if errors != 1 else ''}"))
    print(f"  {', '.join(parts)}")
    print()

    # Exit non-zero on errors so CI / install scripts fail loudly. Warnings
    # are intentionally not fatal: a fresh wheel install won't have a DB
    # yet, and the doctor command should still pass for that user.
    if errors:
        sys.exit(1)


# ── Internals ───────────────────────────────────────────────────────────────


def _read_lead_provider(agents_dir: Path) -> str | None:
    """Return the provider name from the lead agent's ``model:`` field.

    Looks for ``openagentd.md`` first (the seed lead) and falls back to the
    alphabetically-first ``.md`` so non-default deployments still get
    matched. Returns ``None`` if no agent file exists or the model
    line can't be parsed.

    The model spec is ``provider:model-id`` (e.g. ``openai:gpt-5``);
    this only returns the provider half. Any parsing failure returns
    ``None`` rather than raising — doctor shouldn't crash on a
    malformed agent file.
    """
    if not agents_dir.is_dir():
        return None

    candidates = sorted(agents_dir.glob("*.md"))
    if not candidates:
        return None

    lead = agents_dir / "openagentd.md"
    target = lead if lead.is_file() else candidates[0]

    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return None

    # YAML frontmatter is delimited by ``---`` on its own line. Bail if
    # we don't see one within the first few lines — the file isn't shaped
    # like an agent spec.
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        # Match ``model: provider:model-id`` (optionally quoted).
        if stripped.startswith("model:"):
            value = stripped.removeprefix("model:").strip().strip('"').strip("'")
            if ":" in value:
                provider, _, _model = value.partition(":")
                return provider.strip() or None
            return None
    return None

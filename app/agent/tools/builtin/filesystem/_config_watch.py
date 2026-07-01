"""Filesystem-tool post-mutation hook for config caches.

Filesystem tools (``write``, ``edit``, ``rm``) call :func:`notify_fs_change`
after a successful mutation.  The hook decides whether the path falls
under one of the config trees that have process-level caches, and
invalidates the right cache.

This matters for any skills root the skill tool scans:

* ``{SKILLS_DIR}``                     — global, from settings
* ``{workspace}/.openagentd/skills/``  — project-local (OpenAgentd-native)
* ``{workspace}/.opencode/skills/``    — project-local (opencode reuse)

The ``discover_skills`` cache in ``app.agent.tools.builtin.skill`` is
mtime-keyed, so it self-heals on the next call, but eagerly clearing
the LRU avoids relying on filesystem mtime granularity (1s on most
platforms) when the agent writes a skill and immediately validates it
in the same turn.

Kept in this module (not in the skill module itself) to avoid pulling
``functools.lru_cache`` internals across module boundaries from fs-tool
imports, and to keep the dependency direction one-way:
filesystem tools → builtin.skill, never the reverse.
"""

from __future__ import annotations

from pathlib import Path

from loguru import logger


def _skills_roots() -> list[Path]:
    """Return all skill roots that the skill tool scans, resolved to absolute paths.

    Mirrors the precedence list in ``_iter_skill_roots()`` — any path whose
    ``SKILL.md`` files are tracked by the discover cache must be listed here
    so a write/edit/rm inside it triggers an eager cache clear.
    """
    roots: list[Path] = []

    # Global skills dir from settings.
    try:
        from app.core.config import settings

        roots.append(Path(settings.SKILLS_DIR).resolve())
    except Exception:  # noqa: BLE001 — settings missing in some test contexts
        pass

    # Project-local roots — derived from the active sandbox workspace.
    try:
        from app.agent.sandbox import get_sandbox

        workspace = get_sandbox().workspace_root.resolve()
        roots.append((workspace / ".openagentd" / "skills").resolve())
        roots.append((workspace / ".opencode" / "skills").resolve())
    except Exception:  # noqa: BLE001 — no sandbox in some test contexts
        pass

    return roots


def notify_fs_change(resolved_path: Path) -> None:
    """Inform config-aware caches that *resolved_path* was created/edited/deleted.

    Safe to call unconditionally after every successful ``write`` / ``edit``
    / ``rm`` — the helper only does work when the path is inside a known
    config tree.  Exceptions are swallowed and logged because cache
    invalidation must never fail the tool call.
    """
    roots = _skills_roots()
    if not roots:
        return

    under_skills_root = False
    for root in roots:
        try:
            resolved_path.relative_to(root)
            under_skills_root = True
            break
        except ValueError:
            continue
        except Exception as exc:  # noqa: BLE001 — defensive: never fail the caller
            logger.warning(
                "fs_config_watch_check_failed path={} root={} error={}",
                resolved_path,
                root,
                exc,
            )

    if not under_skills_root:
        return

    try:
        from app.agent.tools.builtin.skill import _discover_skills_cached

        _discover_skills_cached.cache_clear()
        logger.debug("fs_config_watch_skill_cache_cleared path={}", resolved_path)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "fs_config_watch_skill_cache_clear_failed path={} error={}",
            resolved_path,
            exc,
        )

"""Skill loader tool — lets agents dynamically load skill instructions.

Skills live in directory roots using the layout
``skills/{skill_name}/SKILL.md``.  Each ``SKILL.md`` has YAML frontmatter
(name, description) followed by a markdown body. Extra files (e.g.
``creating.md``, ``reference/``) may sit alongside ``SKILL.md`` for the
agent to read separately via file tools.

The ``load_skill`` tool reads the skill file and returns its content
so the LLM can apply the instructions in subsequent reasoning.
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

import yaml

from loguru import logger
from pydantic import BaseModel, Field

from app.agent.sandbox import get_sandbox
from app.agent.tools.registry import InjectedArg, tool


class SkillArgs(BaseModel):
    """Arguments for the skill tool."""

    skill_name: str = Field(
        description="Skill name from the available skills listed in this tool description (e.g. 'mcp-installer'). Do not call this again for a skill that is already loaded in the visible conversation; reuse the prior instructions instead because repeated loads return the same content."
    )


def _default_skills_dir() -> Path:
    from app.core.config import settings

    return Path(settings.SKILLS_DIR)


_SKILLS_DIR: Path = _default_skills_dir()


def _project_root() -> Path:
    """Return the active project root for project-local skill discovery."""
    try:
        return get_sandbox().workspace_root
    except Exception:
        return Path.cwd()


def _iter_skill_roots() -> list[Path]:
    """Roots scanned by discovery, in precedence order.

    Mirrors the slash-command precedence so a user's curated library
    works in both tools:

    1. ``{workspace}/.openagentd/skills/``  (project, OpenAgentd-native)
    2. ``{workspace}/.opencode/skills/``    (project, opencode reuse)
    3. ``_SKILLS_DIR``                     (global, OpenAgentd — typically
                                             ``{OPENAGENTD_CONFIG_DIR}/skills``)
    4. ``~/.config/opencode/skills/``      (global, opencode reuse)
    5. bundled OpenAgentd skills           (read-only fallback)

    Earlier entries win on a name collision. ``_SKILLS_DIR`` is
    referenced indirectly (via the module-level binding) so existing
    tests that monkeypatch it keep working.
    """
    project_root = _project_root()
    return [
        project_root / ".openagentd" / "skills",
        project_root / ".opencode" / "skills",
        _SKILLS_DIR,
        Path.home() / ".config" / "opencode" / "skills",
        _builtin_skills_dir(),
    ]


def _builtin_skills_dir() -> Path:
    """Directory containing bundled read-only OpenAgentd skills."""
    return Path(__file__).resolve().parents[2] / "builtin_skills"


def _render_tokens(text: str, *, skill_dir: Path | None = None) -> str:
    """Replace ``{OPENAGENTD_CONFIG_DIR}`` / ``{SKILLS_DIR}`` / ``{AGENTS_DIR}`` /
    ``{SKILL_DIR}`` placeholders so the agent sees concrete paths it can
    hand straight to its file and shell tools.

    Supports both `{TOKEN}` and `${TOKEN}` syntax.
    """
    if not text:
        return text
    # Lazy import matches the existing convention in this module
    # (see ``_default_skills_dir``) — builtin tools avoid pulling
    # ``settings`` at import time.
    from app.core.config import settings

    tokens = {
        "OPENAGENTD_CONFIG_DIR": settings.OPENAGENTD_CONFIG_DIR,
        "AGENTS_DIR": settings.AGENTS_DIR,
        "SKILLS_DIR": settings.SKILLS_DIR,
    }
    if skill_dir is not None:
        try:
            workspace = get_sandbox().workspace_root
        except Exception:
            workspace = None

        is_project_skill = False
        if workspace is not None:
            project_roots = [
                (workspace / ".openagentd" / "skills").resolve(),
                (workspace / ".opencode" / "skills").resolve(),
            ]
            is_project_skill = any(
                skill_dir.resolve().is_relative_to(root) for root in project_roots
            )

        if is_project_skill and workspace is not None:
            # Project skill: resolve to a relative path within the workspace
            tokens["SKILL_DIR"] = str(
                skill_dir.resolve().relative_to(workspace.resolve())
            )
        else:
            # Global or bundled skill: resolve to an absolute path
            tokens["SKILL_DIR"] = str(skill_dir.resolve())

    for name, value in tokens.items():
        text = text.replace("${" + name + "}", value)
        text = text.replace("{" + name + "}", value)
    return text


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body.

    Returns ``(metadata_dict, body_str)``.  If no frontmatter is
    found, metadata is empty and body is the full text.
    """
    match = re.match(
        r"^---\s*\n(.*?)\n---\s*\n(.*)$",
        text,
        re.DOTALL,
    )
    if not match:
        return {}, text.strip()
    meta = yaml.safe_load(match.group(1)) or {}
    body = match.group(2).strip()
    return meta, body


def discover_skills(
    skills_dir: Path | None = None,
) -> dict[str, dict]:
    """Discover all available skills and their metadata.

    Returns a dict mapping skill name → metadata dict.

    With ``skills_dir`` omitted, walks the roots in
    ``_iter_skill_roots()`` (project + global, OpenAgentd + opencode) in
    precedence order, ending with bundled read-only OpenAgentd skills —
    first source wins on a name collision. Pass an explicit
    ``skills_dir`` to scan a single root (used by tests).

    Uses an mtime-keyed cache so the next call after a skill is added,
    removed, or its ``SKILL.md`` edited returns the fresh listing
    without an explicit invalidation. The signature aggregates every
    root we scan, so a mutation in any one of them invalidates the
    cache.
    """
    if skills_dir is not None:
        if not skills_dir.is_dir():
            return {}
        return _discover_skills_cached(
            (str(skills_dir),), _skills_dir_signature(skills_dir)
        )

    roots = [r for r in _iter_skill_roots() if r.is_dir()]
    if not roots:
        return {}
    signature = tuple(_skills_dir_signature(r) for r in roots)
    return _discover_skills_cached(tuple(str(r) for r in roots), signature)


def _skills_dir_signature(directory: Path) -> int:
    """Cheap fingerprint that changes whenever any SKILL.md in the tree changes.

    ~1ms for a typical user's <20 skills.  Returns the max of the directory's
    own mtime_ns and every ``{name}/SKILL.md`` (flat) or
    ``{parent}/{sub}/SKILL.md`` (one nested level) mtime_ns we can stat — so
    in-place edits, additions, and removals all change the signature.
    """
    try:
        max_mtime = directory.stat().st_mtime_ns
    except OSError:
        return 0
    for subdir in directory.iterdir():
        if not subdir.is_dir():
            continue
        # Flat skill: {parent}/SKILL.md
        skill_file = subdir / "SKILL.md"
        try:
            mtime = skill_file.stat().st_mtime_ns
            if mtime > max_mtime:
                max_mtime = mtime
        except OSError:
            pass
        # One nested level: {parent}/{sub}/SKILL.md
        for nested in subdir.iterdir():
            if not nested.is_dir():
                continue
            nested_file = nested / "SKILL.md"
            try:
                mtime = nested_file.stat().st_mtime_ns
                if mtime > max_mtime:
                    max_mtime = mtime
            except OSError:
                continue
    return max_mtime


@lru_cache(maxsize=16)
def _discover_skills_cached(
    directories: tuple[str, ...], signature: int | tuple[int, ...]
) -> dict[str, dict]:
    """Cache keyed by ``(roots, mtime signature)``.

    *directories* is the ordered tuple of roots to walk; the first
    occurrence of a skill name wins. The signature changes on any
    add/remove/edit inside any root, so subsequent calls automatically
    pick up filesystem mutations.  Stale cache entries from prior
    signatures are evicted by the LRU bound.
    """
    skills: dict[str, dict] = {}
    for directory_str in directories:
        directory = Path(directory_str)
        for path, stem in _iter_skill_paths(directory):
            try:
                text = path.read_text(encoding="utf-8")
                meta, _ = _parse_frontmatter(text)
                name = meta.get("name", stem)
                description = _render_tokens(
                    meta.get("description", ""), skill_dir=path.parent
                )
            except OSError:
                # Keep unreadable skills discoverable by their path stem so UI
                # routes can surface the read error instead of the whole
                # catalog failing to load. ``format_available_skills`` filters
                # empty descriptions, so broken entries are not advertised to
                # agents in prompts.
                name = stem
                description = ""
            if name in skills:
                continue  # earlier root wins on collision
            skills[name] = {
                "name": name,
                "description": description,
                "file": str(path.relative_to(directory)),
                # Absolute path to the skill's directory — needed by callers
                # that want to render {SKILL_DIR} in the body without a
                # second filesystem walk.
                "dir": str(path.parent),
            }
    return skills


def format_available_skills(*, verbose: bool = False) -> str:
    """Render discovered skills for prompt/tool-description context."""
    skills = [
        info
        for info in discover_skills().values()
        if str(info.get("description", "")).strip()
    ]
    if not skills:
        return "No skills are currently available."

    skills.sort(key=lambda info: str(info.get("name", "")))
    if verbose:
        lines = ["<available_skills>"]
        for info in skills:
            lines += [
                "  <skill>",
                f"    <name>{info['name']}</name>",
                f"    <description>{info['description']}</description>",
                f"    <location>{Path(str(info['dir'])).as_uri()}</location>",
                "  </skill>",
            ]
        lines.append("</available_skills>")
        return "\n".join(lines)

    return "\n".join(
        ["## Available Skills"]
        + [f"- **{info['name']}**: {info['description']}" for info in skills]
    )


def _skill_tool_description() -> str:
    return "\n".join(
        [
            "Load a specialized skill that provides domain-specific instructions and workflows.",
            "",
            "When a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
            "Call this at most once per skill. If the same skill was already loaded earlier in the visible conversation, reuse those instructions instead of calling this tool again; repeated loads return the same content.",
            "",
            format_available_skills(verbose=False),
        ]
    )


def _iter_skill_paths(directory: Path):
    """Yield ``(skill_file_path, stem)`` for all skills in *directory*.

    Supports two layouts (one nested level maximum):

    * Flat:   ``skills/{name}/SKILL.md``          → stem ``name``
    * Nested: ``skills/{parent}/{sub}/SKILL.md``  → stem ``parent/sub``

    Sub-directories that contain *neither* a ``SKILL.md`` nor any
    nested ``{sub}/SKILL.md`` are silently skipped, so auxiliary files
    (``scripts/``, ``reference/``, …) sitting alongside the skill file
    are never exposed as skills themselves.

    Returns nothing for non-existent or non-directory paths so callers
    can pass roots that may not be present on this machine.
    """
    if not directory.is_dir():
        return
    for subdir in sorted(p for p in directory.iterdir() if p.is_dir()):
        skill_file = subdir / "SKILL.md"
        if skill_file.is_file():
            # Flat skill — yield and *also* check for nested sub-skills
            # below (they coexist with the parent's own SKILL.md).
            yield skill_file, subdir.name
        # One level of nesting: {parent}/{sub}/SKILL.md → "parent/sub"
        for nested in sorted(p for p in subdir.iterdir() if p.is_dir()):
            nested_file = nested / "SKILL.md"
            if nested_file.is_file():
                yield nested_file, f"{subdir.name}/{nested.name}"


def _loaded_skills_from_messages(state: Any) -> dict[str, str]:
    """Return first successful visible skill loads keyed by requested name."""
    loaded: dict[str, str] = {}
    pending_by_tool_call_id: dict[str, str] = {}
    for message in getattr(state, "messages_for_llm", []):
        tool_calls = getattr(message, "tool_calls", None) or []
        for tool_call in tool_calls:
            function = getattr(tool_call, "function", None)
            if getattr(function, "name", None) != "skill":
                continue
            try:
                args = json.loads(getattr(function, "arguments", "") or "{}")
            except (TypeError, json.JSONDecodeError):
                continue
            skill_name = args.get("skill_name")
            if isinstance(skill_name, str) and skill_name and skill_name not in loaded:
                loaded[skill_name] = ""
                tool_call_id = getattr(tool_call, "id", None)
                if isinstance(tool_call_id, str) and tool_call_id:
                    pending_by_tool_call_id[tool_call_id] = skill_name

        tool_call_id = getattr(message, "tool_call_id", None)
        if not isinstance(tool_call_id, str):
            continue
        skill_name = pending_by_tool_call_id.pop(tool_call_id, None)
        content = getattr(message, "content", None)
        if skill_name and isinstance(content, str) and content:
            loaded[skill_name] = content
    return loaded


@tool(name="skill", description=_skill_tool_description, args_schema=SkillArgs)
async def load_skill(
    skill_name: str,
    _state: Annotated[Any, InjectedArg()] = None,
) -> str:
    """Load skill instructions into context."""
    loaded_skills: dict[str, str] = {}
    if _state is not None:
        loaded_skills = _state.metadata.setdefault(
            "loaded_skills", _loaded_skills_from_messages(_state)
        )
        if loaded_skills.get(skill_name):
            logger.info("skill_reused name={}", skill_name)
            return loaded_skills[skill_name]

    roots = [r for r in _iter_skill_roots() if r.is_dir()]
    if not roots:
        return "Skills directory not found."

    for skills_dir in roots:
        for path, stem in _iter_skill_paths(skills_dir):
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
            meta, body = _parse_frontmatter(text)
            name = meta.get("name", stem)
            if name == skill_name or stem == skill_name:
                rel = path.relative_to(skills_dir)
                logger.info("skill_loaded name={} file={}", name, rel)
                # Expand placeholders ({OPENAGENTD_CONFIG_DIR}, {SKILL_DIR}, etc.)
                # so the agent receives concrete paths it can hand to its
                # file/shell tools without further interpretation.
                rendered = _render_tokens(body, skill_dir=path.parent)
                loaded_skills[skill_name] = rendered
                if name != skill_name:
                    loaded_skills[name] = rendered
                if stem != skill_name:
                    loaded_skills[stem] = rendered
                return rendered

    available = list(discover_skills().keys())
    return f"Skill '{skill_name}' not found. Available: {available}"

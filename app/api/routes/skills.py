"""Skill CRUD + runtime-visible catalog for Settings.

The runtime skill loader sees multiple roots (project/global OpenAgentd,
opencode, bundled). The Settings list mirrors that full catalog. Non-bundled
skills are edited/deleted in place; bundled skills remain read-only.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException

from app.core.config import settings

from app.api.schemas.skills import (
    SkillDeleteResponse,
    SkillDetail,
    SkillListResponse,
    SkillSummary,
    SkillWriteRequest,
)
from app.services import agent_fs, team_manager
from app.services.agent_fs import (
    AgentFsConflictError,
    AgentFsNotFoundError,
    AgentFsPathError,
)

router = APIRouter()


# ── Helpers ─────────────────────────────────────────────────────────────────


def _builtin_skills_root() -> Path:
    return Path(__file__).resolve().parents[2] / "agent" / "builtin_skills"


def _builtin_skill_names() -> set[str]:
    root = _builtin_skills_root()
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file()}


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _skill_source(path: Path) -> str:
    """Return a user-facing source label for a discovered SKILL.md path."""
    from app.agent.tools.builtin import skill as skill_module

    resolved = path.resolve()
    config_skills = Path(settings.SKILLS_DIR).resolve()
    config_dir = Path(settings.OPENAGENTD_CONFIG_DIR).resolve()
    opencode_global = Path.home() / ".config" / "opencode" / "skills"
    project_root = skill_module._project_root().resolve()
    if _is_relative_to(resolved, project_root / ".openagentd" / "skills"):
        return "project-openagentd"
    if _is_relative_to(resolved, project_root / ".opencode" / "skills"):
        return "project-opencode"
    if _is_relative_to(resolved, config_skills):
        return "global-openagentd"
    if _is_relative_to(resolved, opencode_global):
        return "global-opencode"
    if _is_relative_to(resolved, _builtin_skills_root()):
        return "builtin"
    if _is_relative_to(resolved, config_dir):
        return "global-openagentd"
    return "unknown"


def _is_editable_skill(path: Path) -> bool:
    """Every discovered, non-bundled skill is editable/deletable in Settings."""
    return not _is_relative_to(path, _builtin_skills_root())


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def _delete_skill_file(path: Path) -> None:
    if not path.is_file():
        raise AgentFsNotFoundError(f"Skill '{path}' not found.")
    path.unlink()
    try:
        path.parent.rmdir()
    except OSError:
        pass
    else:
        parent = path.parent.parent
        # Clean up an empty parent for one-level nested skills, but never walk
        # above a known skill root.
        source = _skill_source(path)
        root_by_source = {
            "project-openagentd": Path.cwd() / ".openagentd" / "skills",
            "project-opencode": Path.cwd() / ".opencode" / "skills",
            "global-openagentd": Path(settings.SKILLS_DIR),
            "global-opencode": Path.home() / ".config" / "opencode" / "skills",
        }
        root = root_by_source.get(source)
        if root is not None and parent.resolve() != root.resolve():
            try:
                parent.rmdir()
            except OSError:
                pass


def _discover_runtime_skills() -> dict[str, dict]:
    """Discover skills using the current settings object.

    The skill tool stores the OpenAgentd-global skills directory in a module
    binding for performance and historical monkeypatching tests. Settings API
    tests (and runtime config edits) may patch ``settings.SKILLS_DIR`` after
    import, so keep the binding in sync before discovery.
    """
    from app.agent.tools.builtin import skill as skill_module

    skill_module._SKILLS_DIR = Path(settings.SKILLS_DIR)
    return skill_module.discover_skills()


def _validate_skill_route_name(name: str) -> None:
    """Validate route skill-name syntax while still allowing external roots."""
    try:
        agent_fs.read_skill(name)
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AgentFsNotFoundError:
        pass


def _parse_skill(name: str, content: str) -> tuple[str, str | None]:
    """Return ``(description, error)`` from a SKILL.md body."""
    from app.agent.tools.builtin.skill import _parse_frontmatter

    try:
        meta, _ = _parse_frontmatter(content, strict=True)
    except Exception as exc:
        return "", f"Invalid frontmatter: {exc}"

    if not isinstance(meta, dict):
        return "", "Frontmatter must be a YAML mapping."

    desc = meta.get("description", "")
    if not isinstance(desc, str):
        return "", "'description' must be a string."
    frontmatter_name = meta.get("name", name)
    if frontmatter_name != name:
        return desc, (
            f"Frontmatter name '{frontmatter_name}' does not match directory "
            f"name '{name}'."
        )
    return desc.strip(), None


# ── Routes ──────────────────────────────────────────────────────────────────


@router.get("")
async def list_skills() -> SkillListResponse:
    rows: list[SkillSummary] = []
    for name, info in _discover_runtime_skills().items():
        path = Path(str(info.get("dir", ""))) / "SKILL.md"
        source = _skill_source(path)
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            rows.append(
                SkillSummary(
                    name=name,
                    valid=False,
                    error=str(exc),
                    built_in=source == "builtin",
                    editable=False,
                    source=source,
                )
            )
            continue
        desc, err = _parse_skill(name, text)
        rows.append(
            SkillSummary(
                name=name,
                description=desc,
                valid=err is None,
                error=err,
                built_in=source == "builtin",
                editable=_is_editable_skill(path),
                source=source,
            )
        )
    rows.sort(key=lambda row: row.name)
    return SkillListResponse(skills=rows)


@router.get("/{name:path}")
async def get_skill(name: str) -> SkillDetail:
    _validate_skill_route_name(name)
    info = _discover_runtime_skills().get(name)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found.")
    path = Path(str(info.get("dir", ""))) / "SKILL.md"
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    desc, err = _parse_skill(name, content)
    source = _skill_source(path)
    return SkillDetail(
        name=name,
        path=str(path),
        content=content,
        description=desc,
        error=err,
        built_in=source == "builtin",
        editable=_is_editable_skill(path),
        source=source,
    )


@router.post("", status_code=201)
async def create_skill(body: SkillWriteRequest) -> SkillDetail:
    desc, err = _parse_skill(body.name, body.content)
    if err is not None:
        raise HTTPException(status_code=422, detail=err)

    try:
        record = agent_fs.write_skill(body.name, body.content, create=True)
    except AgentFsConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except AgentFsPathError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    team_manager.invalidate_skill_cache()
    return SkillDetail(
        name=record.name,
        path=record.path,
        content=record.content,
        description=desc,
    )


@router.put("/{name:path}")
async def update_skill(name: str, body: SkillWriteRequest) -> SkillDetail:
    _validate_skill_route_name(name)
    if body.name != name:
        raise HTTPException(
            status_code=422,
            detail=f"URL name '{name}' does not match body name '{body.name}'.",
        )
    info = _discover_runtime_skills().get(name)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found.")
    existing_path = Path(str(info.get("dir", ""))) / "SKILL.md"
    if not _is_editable_skill(existing_path):
        raise HTTPException(
            status_code=403,
            detail=f"Skill '{name}' is read-only because it comes from {_skill_source(existing_path)}.",
        )

    desc, err = _parse_skill(name, body.content)
    if err is not None:
        raise HTTPException(status_code=422, detail=err)

    try:
        _atomic_write(existing_path, body.content)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    team_manager.invalidate_skill_cache()
    source = _skill_source(existing_path)
    return SkillDetail(
        name=name,
        path=str(existing_path),
        content=body.content,
        description=desc,
        editable=True,
        source=source,
        built_in=source == "builtin",
    )


@router.delete("/{name:path}")
async def delete_skill(name: str) -> SkillDeleteResponse:
    _validate_skill_route_name(name)
    info = _discover_runtime_skills().get(name)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found.")
    path = Path(str(info.get("dir", ""))) / "SKILL.md"
    if not _is_editable_skill(path):
        raise HTTPException(
            status_code=403,
            detail=f"Skill '{name}' is read-only because it comes from {_skill_source(path)}.",
        )
    try:
        _delete_skill_file(path)
    except AgentFsNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    team_manager.invalidate_skill_cache()
    return SkillDeleteResponse(name=name)

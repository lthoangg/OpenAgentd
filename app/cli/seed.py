"""Seed-bundle installer — materialises the default agent team and
configuration files into a fresh user's config directory.

What ships
----------
- ``agents/`` — one ``.md`` per normal agent plus ``agents/coding/`` for
  coding mode. ``model: __PROVIDER_MODEL__`` is rewritten to the
  provider:model the user picked in ``init``. Existing files are preserved,
  except this placeholder token may be replaced in-place after first-run
  desktop seeding. First-party files removed from the curated seed set are
  pruned only when they still look like untouched legacy seed files.
- ``skills/`` — optional user-editable skills. Core operational skills ship
  as read-only builtins under ``app/agent/builtin_skills`` instead.
- Top-level config files: ``mcp.json`` plus generated ``settings.yaml``
  and ``multimodal.yaml``. These are the defaults the user can edit later;
  any file already present in the user's config dir is left untouched.
  ``summarization.md`` is **not** seeded — the summariser prompt lives in
  code (see ``CHAT_SUMMARY_PROMPT`` / ``CODING_SUMMARY_PROMPT`` in
  ``app.agent.hooks.summarization``), along with numeric thresholds.

Sources, in order of preference
-------------------------------
1. **Local source checkout** — if a ``seed/`` directory is present next
   to the running package (i.e. the user is running from a git clone),
   we copy from there. Zero network, instant, and dev edits show up
   immediately.
2. **GitHub release tarball** — for the running app version
   (``https://github.com/{REPO}/archive/refs/tags/v{VERSION}.tar.gz``).
3. **GitHub ``main`` branch** — fallback if the tag isn't published yet.

We only ever copy the ``seed/`` subtree, and we only ever *fill in
gaps*: files that already exist in the user's config dir are kept
untouched. Once a user has a populated config, those files are theirs
(think ``.bashrc``, not a managed package). Updates to seed prompts or
skills ship by users browsing the repo and copying what they want.
"""

from __future__ import annotations

import io
import re
import shutil
import tarfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import yaml

# PROVIDER_MODEL_TOKEN's canonical home is app.core.config — re-exported here
# for callers that historically imported it from the seed module.
from app.core.config import PROVIDER_MODEL_TOKEN as PROVIDER_MODEL_TOKEN
from app.core.version import VERSION

#: GitHub ``owner/repo`` that hosts the seed bundle.
#: Update this if the canonical repo location changes.
REPO = "lthoangg/openagentd"

#: Top-level files inside ``seed/`` that ship as user-editable config.
#: Anything else at seed root (README.md, etc.) is **not** copied.
_SEED_ROOT_FILES: frozenset[str] = frozenset(
    {
        "mcp.json",
    }
)

#: Top-level *directories* under ``seed/`` whose contents are copied wholesale.
_SEED_TREE_DIRS: frozenset[str] = frozenset({"agents", "skills"})

#: Network timeout (seconds) for each GitHub fetch attempt.
_FETCH_TIMEOUT = 20

_DEFAULT_MULTIMODAL_YAML = """\
image:
  model: googlegenai:gemini-3.1-flash-image-preview
  aspect_ratio: "1:1"
  image_size: 1K

video:
  model: googlegenai:veo-3.1-generate-preview
  aspect_ratio: "16:9"
  resolution: "720p"
  duration_seconds: "8"
"""

_REMOVED_FIRST_PARTY_AGENT_FILES: dict[str, str] = {
    "agents/consultant.md": "consultant",
    "agents/coding/architect.md": "architect",
    "agents/coding/designer.md": "designer",
    "agents/coding/executor.md": "executor",
    "agents/coding/qa.md": "qa",
}


@dataclass(slots=True)
class SeedResult:
    """Outcome of a seed install."""

    agents_written: list[str]
    skills_written: list[str]
    configs_written: list[str]  # top-level mcp.json/multimodal.yaml/etc.
    agents_removed: list[str]
    source: str  # "local", "tag:v0.1.0", or "branch:main"


class SeedDownloadError(RuntimeError):
    """Raised when neither the tagged release nor ``main`` can be fetched."""


# ── .env credential writer ──────────────────────────────────────────────────


def write_env_credentials(
    env_file: Path,
    credentials: dict[str, str],
    *,
    comments: dict[str, str] | None = None,
) -> bool:
    """Merge ``credentials`` into ``env_file``, creating it if absent.

    Used by both the CLI's ``init`` command and the desktop's Settings →
    Providers page. Known keys are replaced in place; new keys are
    appended. Lines the function doesn't recognise (extra vars the user
    added, comments) are preserved verbatim — this is a merge, not a
    rewrite.

    Parameters
    ----------
    env_file
        Absolute path to ``~/.config/openagentd/.env`` (or the test
        equivalent).
    credentials
        Mapping of env-var name → value to write. An empty-string value
        means "clear this key" — the line is dropped from the file
        entirely (rather than left as ``KEY=``) so ``pydantic-settings``
        falls back to its declared default instead of resolving to the
        empty string.
    comments
        Optional mapping of env-var name → comment line. The comment is
        appended below the var when *adding* it for the first time, not
        on subsequent updates (to avoid duplicating annotations).

    Returns
    -------
    bool
        ``True`` if the file was created, ``False`` if it was merged
        in place. Callers use this to pick a one-liner log message.
    """
    comments = comments or {}
    env_file.parent.mkdir(parents=True, exist_ok=True)

    if not env_file.exists():
        lines = [
            "# Generated by openagentd",
            "# Edit as needed. See .env.example for the full reference.",
            "",
            "APP_ENV=production",
            "",
        ]
        for key, val in credentials.items():
            if not val:
                # Nothing to write — and there's no existing line to
                # supersede on a fresh file.
                continue
            lines.append(f"{key}={val}")
            if key in comments:
                lines.append(comments[key])
        env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return True

    existing = env_file.read_text(encoding="utf-8")
    out_lines: list[str] = []
    handled: set[str] = set()
    for line in existing.splitlines():
        key = line.split("=", 1)[0].strip()
        if key in credentials:
            handled.add(key)
            new_val = credentials[key]
            if new_val:
                out_lines.append(f"{key}={new_val}")
            # else: empty value → drop the line (caller asked to clear).
        else:
            out_lines.append(line)
    for key, val in credentials.items():
        if key in handled or not val:
            continue
        out_lines.append(f"{key}={val}")
        if key in comments:
            out_lines.append(comments[key])
    env_file.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return False


# ── Public API ───────────────────────────────────────────────────────────────


def install_seed(
    config_dir: Path,
    *,
    provider_model: str,
) -> SeedResult:
    """Install the seed bundle into ``config_dir``.

    Files that already exist on disk are kept untouched — this only
    fills in gaps. Once a user has a populated config, the files are
    theirs to edit; there is no "refresh from upstream" flow.

    Parameters
    ----------
    config_dir
        Target ``{OPENAGENTD_CONFIG_DIR}`` — ``agents/`` and ``skills/`` are
        materialised inside it.
    provider_model
        ``"<provider>:<model>"`` string substituted for the
        ``__PROVIDER_MODEL__`` token in every agent file.

    Raises
    ------
    SeedDownloadError
        If neither a local ``seed/`` directory nor a GitHub fetch
        succeeds.
    """
    local = _local_seed_dir()
    if local is not None:
        return _install_from_local(local, config_dir, provider_model=provider_model)
    return _install_from_github(config_dir, provider_model=provider_model)


# ── Local-checkout source ────────────────────────────────────────────────────


def _local_seed_dir() -> Path | None:
    """Return the path to a local ``seed/`` directory, if running from
    a source checkout. ``None`` otherwise.
    """
    # app/cli/seed.py → repo root is parent.parent.parent.
    repo_root = Path(__file__).resolve().parent.parent.parent
    candidate = repo_root / "seed"
    if candidate.is_dir() and (candidate / "agents").is_dir():
        return candidate
    return None


def _install_from_local(
    seed_dir: Path,
    config_dir: Path,
    *,
    provider_model: str,
) -> SeedResult:
    agents_written: list[str] = []
    skills_written: list[str] = []
    configs_written: list[str] = []
    agents_removed = _prune_removed_first_party_agents(config_dir)

    from app.core.runtime_settings import ensure_runtime_settings

    if ensure_runtime_settings(
        config_dir / "settings.yaml", provider_model=provider_model
    ):
        configs_written.append("settings.yaml")
    if _ensure_text_config(config_dir / "multimodal.yaml", _DEFAULT_MULTIMODAL_YAML):
        configs_written.append("multimodal.yaml")
    for src in sorted(seed_dir.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(seed_dir)
        if not _is_seed_artefact(rel):
            continue
        target = config_dir / rel
        if target.exists():
            if _replace_placeholder_if_needed(target, provider_model):
                _record(rel, agents_written, skills_written, configs_written)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        _copy_with_substitution(src, target, provider_model)
        _record(rel, agents_written, skills_written, configs_written)

    return SeedResult(
        agents_written=sorted(agents_written),
        skills_written=sorted(skills_written),
        configs_written=sorted(configs_written),
        agents_removed=agents_removed,
        source="local",
    )


# ── GitHub-tarball source ────────────────────────────────────────────────────


def _install_from_github(
    config_dir: Path,
    *,
    provider_model: str,
) -> SeedResult:
    payload, source = _download_seed_tarball()
    agents_written: list[str] = []
    skills_written: list[str] = []
    configs_written: list[str] = []
    agents_removed = _prune_removed_first_party_agents(config_dir)

    from app.core.runtime_settings import ensure_runtime_settings

    if ensure_runtime_settings(
        config_dir / "settings.yaml", provider_model=provider_model
    ):
        configs_written.append("settings.yaml")
    if _ensure_text_config(config_dir / "multimodal.yaml", _DEFAULT_MULTIMODAL_YAML):
        configs_written.append("multimodal.yaml")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tf:
        for member in tf.getmembers():
            rel = _strip_repo_prefix(member.name)
            if rel is None or not rel.startswith("seed/"):
                continue
            # Strip "seed/" → leaves agents/foo.md, optional skills/foo/SKILL.md,
            # or top-level mcp.json / multimodal.yaml / etc.
            target_rel = Path(rel).relative_to("seed")
            if not target_rel.parts or not _is_seed_artefact(target_rel):
                continue
            target = config_dir / target_rel

            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            if target.exists():
                if _replace_placeholder_if_needed(target, provider_model):
                    _record(target_rel, agents_written, skills_written, configs_written)
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            f = tf.extractfile(member)
            if f is None:
                continue
            content = f.read()
            if target_rel.suffix == ".md":
                content = content.replace(
                    PROVIDER_MODEL_TOKEN.encode(), provider_model.encode()
                )
            target.write_bytes(content)
            _record(target_rel, agents_written, skills_written, configs_written)

    return SeedResult(
        agents_written=sorted(agents_written),
        skills_written=sorted(skills_written),
        configs_written=sorted(configs_written),
        agents_removed=agents_removed,
        source=source,
    )


def _download_seed_tarball() -> tuple[bytes, str]:
    """Fetch the seed tarball, preferring the release tag.

    Returns ``(payload, source_label)``.
    """
    candidates = [
        (f"tag:v{VERSION}", _tag_url(VERSION)),
        ("branch:main", _branch_url("main")),
    ]
    last_error: Exception | None = None
    for label, url in candidates:
        try:
            with urllib.request.urlopen(url, timeout=_FETCH_TIMEOUT) as resp:
                return resp.read(), label
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_error = exc
            continue
    raise SeedDownloadError(
        f"Could not download seed bundle from {REPO} "
        f"(tried tag v{VERSION} and main): {last_error}"
    )


def _tag_url(version: str) -> str:
    return f"https://github.com/{REPO}/archive/refs/tags/v{version}.tar.gz"


def _branch_url(branch: str) -> str:
    return f"https://github.com/{REPO}/archive/refs/heads/{branch}.tar.gz"


_REPO_PREFIX_RE = re.compile(r"^[^/]+/")


def _strip_repo_prefix(name: str) -> str | None:
    """GitHub tarballs nest everything under ``<repo>-<ref>/`` — strip it."""
    if not name:
        return None
    stripped = _REPO_PREFIX_RE.sub("", name, count=1)
    return stripped or None


# ── Shared helpers ───────────────────────────────────────────────────────────


def _copy_with_substitution(src: Path, target: Path, provider_model: str) -> None:
    """Copy ``src`` to ``target``; substitute the model token where present."""
    if src.suffix == ".md":
        text = src.read_text(encoding="utf-8")
        target.write_text(
            text.replace(PROVIDER_MODEL_TOKEN, provider_model), encoding="utf-8"
        )
    else:
        shutil.copy2(src, target)


def _ensure_text_config(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def _replace_placeholder_if_needed(target: Path, provider_model: str) -> bool:
    if provider_model == PROVIDER_MODEL_TOKEN or target.suffix != ".md":
        return False
    text = target.read_text(encoding="utf-8")
    if PROVIDER_MODEL_TOKEN not in text:
        return False
    target.write_text(
        text.replace(PROVIDER_MODEL_TOKEN, provider_model), encoding="utf-8"
    )
    return True


def _prune_removed_first_party_agents(config_dir: Path) -> list[str]:
    """Remove obsolete first-party seed files if they are still untouched."""
    removed: list[str] = []
    for rel, expected_name in _REMOVED_FIRST_PARTY_AGENT_FILES.items():
        path = config_dir / rel
        if not path.exists() or not _is_prunable_legacy_agent(path, expected_name):
            continue
        path.unlink()
        removed.append(str(Path(*Path(rel).parts[1:])))
    return sorted(removed)


def _is_prunable_legacy_agent(path: Path, expected_name: str) -> bool:
    from app.agent.loader import _FRONTMATTER_RE

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return False
    raw_meta = yaml.safe_load(match.group(1)) or {}
    body = match.group(2).strip()
    if raw_meta.get("name") != expected_name or raw_meta.get("role") != "member":
        return False
    return not body or body.startswith(
        (f"You are **{expected_name}**.", f'You are "{expected_name}".')
    )


def _record(
    rel: Path,
    agents: list[str],
    skills: list[str],
    configs: list[str],
) -> None:
    """Record a written path in the appropriate result list."""
    if rel.parts[0] == "agents":
        agents.append(str(Path(*rel.parts[1:])))
    elif rel.parts[0] == "skills" and len(rel.parts) >= 2:
        name = rel.parts[1]
        if name not in skills:
            skills.append(name)
    elif len(rel.parts) == 1 and rel.parts[0] in _SEED_ROOT_FILES:
        configs.append(rel.name)


def _is_seed_artefact(rel: Path) -> bool:
    """True if *rel* (relative to seed/) is something we should ship.

    Accepts:
    - Anything under ``agents/`` or ``skills/``.
    - Top-level files explicitly listed in ``_SEED_ROOT_FILES``.

    Rejects ``seed/README.md`` and any other top-level file not in the
    allow-list, plus stray dot-files.
    """
    if not rel.parts:
        return False
    head = rel.parts[0]
    if head in _SEED_TREE_DIRS:
        return True
    if len(rel.parts) == 1 and head in _SEED_ROOT_FILES:
        return True
    return False

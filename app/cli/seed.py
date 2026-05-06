"""Seed-bundle installer — materialises the default agent team, skills,
and configuration files into a fresh user's config directory.

What ships
----------
- ``agents/`` — one ``.md`` per agent. ``model: __PROVIDER_MODEL__`` is
  rewritten to the provider:model the user picked in ``init``.
- ``skills/`` — one subdirectory per skill, each with at minimum a
  ``SKILL.md``.
- Top-level config files: ``mcp.json``, ``multimodal.yaml``, ``speech.yaml``,
  ``summarization.md``, ``title_generation.md``. These are the
  defaults the user can edit later; any file already present in the
  user's config dir is left untouched.

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

from app.core.version import VERSION

#: GitHub ``owner/repo`` that hosts the seed bundle.
#: Update this if the canonical repo location changes.
REPO = "lthoangg/openagentd"

#: Token used as the ``model:`` value in seed agent files.  Replaced at
#: install time with the provider/model the user picked in ``openagentd init``.
PROVIDER_MODEL_TOKEN = "__PROVIDER_MODEL__"

#: Top-level files inside ``seed/`` that ship as user-editable config.
#: Anything else at seed root (README.md, etc.) is **not** copied.
_SEED_ROOT_FILES: frozenset[str] = frozenset(
    {
        "dream.md",
        "mcp.json",
        "multimodal.yaml",
        "speech.yaml",
        "summarization.md",
        "title_generation.md",
    }
)

#: Top-level *directories* under ``seed/`` whose contents are copied wholesale.
_SEED_TREE_DIRS: frozenset[str] = frozenset({"agents", "skills"})

#: Network timeout (seconds) for each GitHub fetch attempt.
_FETCH_TIMEOUT = 20


@dataclass(slots=True)
class SeedResult:
    """Outcome of a seed install."""

    agents_written: list[str]
    skills_written: list[str]
    configs_written: list[str]  # top-level mcp.json/multimodal.yaml/etc.
    source: str  # "local", "tag:v0.1.0", or "branch:main"


class SeedDownloadError(RuntimeError):
    """Raised when neither the tagged release nor ``main`` can be fetched."""


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

    for src in sorted(seed_dir.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(seed_dir)
        if not _is_seed_artefact(rel):
            continue
        target = config_dir / rel
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        _copy_with_substitution(src, target, provider_model)
        _record(rel, agents_written, skills_written, configs_written)

    return SeedResult(
        agents_written=sorted(agents_written),
        skills_written=sorted(skills_written),
        configs_written=sorted(configs_written),
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

    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tf:
        for member in tf.getmembers():
            rel = _strip_repo_prefix(member.name)
            if rel is None or not rel.startswith("seed/"):
                continue
            # Strip "seed/" → leaves agents/foo.md, skills/foo/SKILL.md,
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


def _record(
    rel: Path,
    agents: list[str],
    skills: list[str],
    configs: list[str],
) -> None:
    """Record a written path in the appropriate result list."""
    if rel.parts[0] == "agents":
        agents.append(rel.name)
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

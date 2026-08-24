"""``openagentd transfer import`` — unpack a migration archive on the target server.

Accepts a ``.tar.gz`` produced by ``openagentd transfer export`` and extracts its
contents into ``{OPENAGENTD_CONFIG_DIR}``.

Safety rules
------------
- **Fill-in-gaps by default** — files that already exist on the target are
  left untouched.  Pass ``--force`` to replace them.
- **Path-traversal guard** — any archive entry whose resolved path would land
  outside ``config_dir`` is rejected with a hard error before any extraction
  begins.
- **Prefix validation** — the archive must have the ``openagentd-export/``
  root prefix that ``openagentd transfer export`` always sets.  Bare or foreign
  archives are rejected.
"""

from __future__ import annotations

import argparse
import tarfile
from dataclasses import dataclass, field
from pathlib import Path

from app.cli.paths import _config_dir
from app.cli.ui import _bold, _dim, _green, _red, _yellow

#: Expected root prefix inside every valid openagentd export archive.
ARCHIVE_ROOT = "openagentd-export"


@dataclass(slots=True)
class ImportResult:
    """Outcome of an import operation."""

    files_written: list[str] = field(default_factory=list)
    files_skipped: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Core import logic
# ---------------------------------------------------------------------------


def import_config(
    archive_path: Path,
    *,
    config_dir: Path,
    force: bool = False,
) -> ImportResult:
    """Extract a migration archive into ``config_dir``.

    Parameters
    ----------
    archive_path
        Path to a ``.tar.gz`` produced by ``openagentd transfer export``.
    config_dir
        Target ``{OPENAGENTD_CONFIG_DIR}`` on the destination machine.
    force
        When ``True``, overwrite files that already exist.
        When ``False`` (the default), skip existing files (fill-in-gaps).

    Returns
    -------
    ImportResult
        Lists of files written and files skipped.

    Raises
    ------
    ValueError
        If the archive is not a valid tar.gz, lacks the expected prefix,
        or contains a path-traversal entry.
    """
    # ── 1. Validate: readable tar.gz ──────────────────────────────────────
    if not archive_path.is_file():
        raise ValueError(f"not a valid archive — file not found: {archive_path}")
    try:
        tf_check = tarfile.open(archive_path, "r:gz")
        tf_check.close()
    except tarfile.TarError as exc:
        raise ValueError(f"not a valid tar.gz archive: {exc}") from exc

    config_dir = config_dir.resolve()

    # ── 2. Validate: prefix and path traversal (before any extraction) ────
    with tarfile.open(archive_path, "r:gz") as tf:
        members = tf.getmembers()

    # Check prefix — every file entry must start with ARCHIVE_ROOT/
    file_members = [m for m in members if m.isfile()]
    if not file_members:
        raise ValueError("not a valid openagentd export — archive contains no files")
    for m in file_members:
        if not m.name.startswith(f"{ARCHIVE_ROOT}/"):
            raise ValueError(
                f"not a valid openagentd export — unexpected archive root in entry: {m.name!r}. "
                f"Expected entries under '{ARCHIVE_ROOT}/'."
            )

    # Check path traversal — strip prefix then resolve and ensure inside config_dir
    for m in file_members:
        rel_str = m.name[len(ARCHIVE_ROOT) + 1 :]  # strip "openagentd-export/"
        # Detect explicit traversal attempts before resolving
        if ".." in Path(rel_str).parts:
            raise ValueError(f"path traversal detected in archive entry: {m.name!r}")
        target = (config_dir / rel_str).resolve()
        if not target.is_relative_to(config_dir):
            raise ValueError(f"path traversal detected in archive entry: {m.name!r}")

    # ── 3. Extract ────────────────────────────────────────────────────────
    result = ImportResult()

    with tarfile.open(archive_path, "r:gz") as tf:
        for m in file_members:
            rel_str = m.name[len(ARCHIVE_ROOT) + 1 :]
            target = (config_dir / rel_str).resolve()

            if target.exists() and not force:
                result.files_skipped.append(rel_str)
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            target.write_bytes(f.read())
            result.files_written.append(rel_str)

    return result


# ---------------------------------------------------------------------------
# CLI handler
# ---------------------------------------------------------------------------


def cmd_import(args: argparse.Namespace) -> None:
    config_dir = (
        Path(args.config_dir).expanduser()
        if getattr(args, "config_dir", None)
        else _config_dir()
    )
    archive_path = Path(args.archive).expanduser().resolve()
    force: bool = getattr(args, "force", False)

    print()
    print(f"  {_dim('…')}  Importing from {archive_path}")
    print(f"  {_dim('→')}  Config dir: {config_dir}")
    print()

    try:
        result = import_config(archive_path, config_dir=config_dir, force=force)
    except ValueError as exc:
        print(f"  {_red('✗')}  {exc}")
        raise SystemExit(1) from exc

    if result.files_written:
        print(f"  {_green('✓')}  Wrote {len(result.files_written)} file(s):")
        for f in sorted(result.files_written):
            print(f"    {_green('  +')} {f}")
    if result.files_skipped:
        print(
            f"  {_yellow('ℹ')}  Skipped {len(result.files_skipped)} existing file(s):"
        )
        for f in sorted(result.files_skipped):
            print(f"    {_dim('  ·')} {f}")
        print(
            f"\n  {_dim('Tip: pass')} {_bold('--force')} "
            f"{_dim('to overwrite existing files.')}"
        )

    if not result.files_written and not result.files_skipped:
        print(f"  {_yellow('ℹ')}  Nothing to import — archive appears empty.")

    print()
    print(f"  {_bold('Next:')} start the server:")
    print("    openagentd")
    print()

"""Atomic, owner-only writes for files that hold credentials.

Several call sites persist secrets — provider API keys and MCP server
credentials into ``{CONFIG_DIR}/.env``, OAuth tokens into per-provider JSON.
They independently reimplemented "write the file, then maybe chmod it", and
the ones that forgot the chmod left secrets under the process umask.

``write_secret_file`` is the single way to persist that content.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

_OWNER_ONLY = 0o600


def write_secret_file(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """Write *text* to *path* atomically, readable only by the owner.

    The content goes to a unique temporary sibling opened with ``O_EXCL`` and
    mode ``0600``, so the secret is never briefly visible under a wider mode,
    then is renamed over *path*. A reader therefore sees either the old file
    or the complete new one, never a truncated mix.

    ``chmod`` runs after the rename as well: ``os.replace`` keeps the
    destination's inode permissions in some cases, and a file created before
    this rule existed would otherwise stay world-readable.

    On Windows ``chmod`` only toggles the read-only bit; the atomic replace
    still holds.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique per call: a fixed name would collide between concurrent writers
    # and a stale leftover would make every later write fail on O_EXCL.
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _OWNER_ONLY)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        os.chmod(path, _OWNER_ONLY)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

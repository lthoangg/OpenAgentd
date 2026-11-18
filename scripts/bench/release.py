"""The Linux ``agentd`` a benchmark container runs.

Either a local build, or a release archive downloaded once on the host and
checked against its ``.sha256``. The adapter uploads the binary, so a task
image needs neither ``curl`` nor a package manager.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import tarfile
import urllib.request
from pathlib import Path

RELEASES = "https://github.com/lthoangg/openagentd/releases"
_TARGETS = {
    "x86_64": "x86_64-unknown-linux-gnu",
    "amd64": "x86_64-unknown-linux-gnu",
    "aarch64": "aarch64-unknown-linux-gnu",
    "arm64": "aarch64-unknown-linux-gnu",
}
_VERSION = re.compile(r"^[0-9]+(\.[0-9A-Za-z-]+)+$")


def target_for(machine: str) -> str:
    """The release target for a container's ``uname -m``."""
    try:
        return _TARGETS[machine.strip()]
    except KeyError:
        raise ValueError(f"no Linux agentd release for machine {machine.strip()!r}") from None


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def latest_version(releases: str = RELEASES) -> str:
    """The version ``<releases>/latest`` redirects to."""
    with urllib.request.urlopen(f"{releases}/latest", timeout=60) as response:
        return response.url.rstrip("/").rsplit("/", 1)[-1].removeprefix("v")


def local_binary(dist_dir: Path, machine: str) -> Path:
    """``<dist_dir>/<target>/agentd``: a build made for this machine."""
    binary = Path(dist_dir) / target_for(machine) / "agentd"
    if not binary.is_file():
        raise FileNotFoundError(f"no local build at {binary}")
    return binary


def release_binary(version: str, machine: str, cache: Path, releases: str = RELEASES) -> Path:
    """The released binary for ``machine``, downloaded into ``cache`` once."""
    if not _VERSION.match(version):
        raise ValueError(f"{version!r} is not a release version")
    target = target_for(machine)
    binary = Path(cache) / version / target / "agentd"
    if binary.is_file():
        return binary
    name = f"openagentd-{version}-{target}.tar.gz"
    url = f"{releases}/download/v{version}/{name}"
    archive = _get(url)
    expected = _get(f"{url}.sha256").split()[0].decode()
    actual = hashlib.sha256(archive).hexdigest()
    if actual != expected:
        raise ValueError(f"checksum mismatch for {name} (expected {expected}, got {actual})")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        member = next((m for m in tar.getmembers() if m.isfile() and m.name.lstrip("./") == "agentd"), None)
        extracted = tar.extractfile(member) if member else None
        data = extracted.read() if extracted else None
    if data is None:
        raise ValueError(f"{name} does not contain agentd")
    binary.parent.mkdir(parents=True, exist_ok=True)
    partial = binary.with_name("agentd.partial")
    partial.write_bytes(data)
    partial.chmod(0o755)
    os.replace(partial, binary)
    return binary

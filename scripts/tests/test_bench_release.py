"""``scripts/bench/release.py`` finds the Linux ``agentd`` a task container runs."""

from __future__ import annotations

import hashlib
import http.server
import importlib.util
import io
import tarfile
import threading
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bench/release.py"
_spec = importlib.util.spec_from_file_location("bench_release", _SCRIPT)
assert _spec and _spec.loader
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)


def _archive(binary: bytes) -> bytes:
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name in ("./agentd", "./openagentd", "./LICENSE"):
            info = tarfile.TarInfo(name)
            info.size = len(binary)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(binary))
    return out.getvalue()


@pytest.fixture
def releases(tmp_path: Path):
    """A stand-in for the GitHub releases pages. Yields its base URL, the
    files it serves by path, and the paths it was asked for."""
    files: dict[str, bytes] = {}
    asked: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append(self.path)
            if self.path == "/latest":
                self.send_response(302)
                self.send_header("Location", "/tag/v9.8.7")
                self.end_headers()
                return
            body = files.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.end_headers()
            self.wfile.write(body or b"")

        def log_message(self, format, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    files["/tag/v9.8.7"] = b"release page"
    yield f"http://127.0.0.1:{server.server_address[1]}", files, asked
    server.shutdown()


def _publish(files: dict[str, bytes], version: str, target: str, binary: bytes, sha: str | None = None) -> None:
    archive = _archive(binary)
    path = f"/download/v{version}/openagentd-{version}-{target}.tar.gz"
    files[path] = archive
    digest = sha or hashlib.sha256(archive).hexdigest()
    files[path + ".sha256"] = f"{digest}  openagentd-{version}-{target}.tar.gz\n".encode()


@pytest.mark.parametrize(
    "machine, target",
    [
        ("x86_64", "x86_64-unknown-linux-gnu"),
        ("amd64", "x86_64-unknown-linux-gnu"),
        ("aarch64", "aarch64-unknown-linux-gnu"),
        ("arm64", "aarch64-unknown-linux-gnu"),
    ],
)
def test_a_container_gets_the_archive_built_for_its_machine(machine: str, target: str):
    assert release.target_for(machine) == target


def test_a_machine_with_no_release_is_refused():
    with pytest.raises(ValueError, match="riscv64"):
        release.target_for("riscv64")


def test_the_latest_release_is_the_one_the_releases_page_redirects_to(releases):
    base, _, _ = releases
    assert release.latest_version(base) == "9.8.7"


def test_a_release_binary_is_downloaded_once_and_checked(tmp_path: Path, releases):
    base, files, asked = releases
    _publish(files, "9.8.7", "aarch64-unknown-linux-gnu", b"arm binary")

    binary = release.release_binary("9.8.7", "aarch64", tmp_path / "cache", base)
    assert binary.read_bytes() == b"arm binary"
    assert binary.stat().st_mode & 0o111, "it must be executable"

    asked.clear()
    assert release.release_binary("9.8.7", "arm64", tmp_path / "cache", base) == binary
    assert asked == [], "the second container reuses the download"


def test_an_archive_that_does_not_match_its_checksum_is_refused(tmp_path: Path, releases):
    base, files, _ = releases
    _publish(files, "9.8.7", "x86_64-unknown-linux-gnu", b"binary", sha="0" * 64)
    with pytest.raises(ValueError, match="checksum"):
        release.release_binary("9.8.7", "x86_64", tmp_path / "cache", base)
    assert not list((tmp_path / "cache").rglob("agentd")), "nothing is kept"


def test_a_version_that_is_not_a_version_is_refused(tmp_path: Path, releases):
    base, _, asked = releases
    with pytest.raises(ValueError, match="version"):
        release.release_binary("../../etc", "x86_64", tmp_path / "cache", base)
    assert asked == []


def test_a_local_build_is_used_as_it_is(tmp_path: Path):
    built = tmp_path / "x86_64-unknown-linux-gnu" / "agentd"
    built.parent.mkdir()
    built.write_bytes(b"local")
    assert release.local_binary(tmp_path, "x86_64") == built
    with pytest.raises(FileNotFoundError, match="aarch64-unknown-linux-gnu"):
        release.local_binary(tmp_path, "aarch64")

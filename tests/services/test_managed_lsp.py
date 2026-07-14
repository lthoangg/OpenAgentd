from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.services.lsp.managed import (
    BunAsset,
    ManagedLspTools,
    TYPESCRIPT_LANGUAGE_SERVER_VERSION,
    TYPESCRIPT_VERSION,
    find_packaged_python_command,
)


def _mark_typescript_ready(tools: ManagedLspTools) -> None:
    tools.bun_path.parent.mkdir(parents=True)
    tools.bun_path.write_bytes(b"bun")
    tools.bun_path.chmod(0o755)
    tools.typescript_language_server_path.parent.mkdir(parents=True)
    tools.typescript_language_server_path.write_text("// cli")
    tools.managed_tsserver_path.parent.mkdir(parents=True)
    tools.managed_tsserver_path.write_text("// tsserver")
    (tools.packages_dir / "package.json").write_text(
        json.dumps(
            {
                "dependencies": {
                    "typescript": TYPESCRIPT_VERSION,
                    "typescript-language-server": TYPESCRIPT_LANGUAGE_SERVER_VERSION,
                }
            }
        )
    )


def test_managed_typescript_manifest_matches_runtime_versions():
    resource = (
        Path(__file__).parents[2]
        / "app"
        / "services"
        / "lsp"
        / "resources"
        / "package.json"
    )
    dependencies = json.loads(resource.read_text())["dependencies"]

    assert dependencies == {
        "typescript": TYPESCRIPT_VERSION,
        "typescript-language-server": TYPESCRIPT_LANGUAGE_SERVER_VERSION,
    }


def test_managed_bun_uses_musl_build_on_alpine(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Linux")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "x86_64")
    monkeypatch.setattr(
        "app.services.lsp.managed.platform.libc_ver", lambda: ("musl", "1.2")
    )

    assert tools._asset().filename == "bun-linux-x64-musl-baseline.zip"


def test_find_packaged_python_command_uses_runtime_site_bin(tmp_path, monkeypatch):
    site_packages = tmp_path / "site-packages"
    binary = site_packages / "bin" / ("ty.exe" if os.name == "nt" else "ty")
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"binary")
    binary.chmod(0o755)

    monkeypatch.setattr(
        "app.services.lsp.managed._packaged_bin_dirs",
        lambda: [site_packages / "bin"],
    )

    assert find_packaged_python_command("ty") == [str(binary), "server"]


def test_typescript_command_uses_managed_bun_and_project_typescript(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    _mark_typescript_ready(tools)

    project = tmp_path / "project"
    project_tsserver = project / "node_modules" / "typescript" / "lib" / "tsserver.js"
    project_tsserver.parent.mkdir(parents=True)
    project_tsserver.write_text("// project")

    resolved = tools.typescript_command(project)

    assert resolved is not None
    command, tsserver = resolved
    assert command == [
        str(tools.bun_path),
        str(tools.typescript_language_server_path),
        "--stdio",
    ]
    assert tsserver == project_tsserver


def test_typescript_command_falls_back_to_managed_typescript(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    _mark_typescript_ready(tools)

    resolved = tools.typescript_command(tmp_path / "project")

    assert resolved is not None
    assert resolved[1] == tools.managed_tsserver_path


def test_typescript_command_rejects_stale_managed_packages(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    _mark_typescript_ready(tools)
    (tools.packages_dir / "package.json").write_text(
        json.dumps(
            {
                "dependencies": {
                    "typescript": "old",
                    "typescript-language-server": "old",
                }
            }
        )
    )

    assert tools.typescript_command(tmp_path / "project") is None


def test_project_typescript_symlink_outside_project_uses_managed_copy(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    _mark_typescript_ready(tools)
    outside = tmp_path / "outside" / "typescript"
    (outside / "lib").mkdir(parents=True)
    (outside / "lib" / "tsserver.js").write_text("// outside")
    project = tmp_path / "project"
    (project / "node_modules").mkdir(parents=True)
    try:
        (project / "node_modules" / "typescript").symlink_to(
            outside, target_is_directory=True
        )
    except OSError:
        pytest.skip("directory symlinks unavailable")

    resolved = tools.typescript_command(project)
    assert resolved is not None
    assert resolved[1] == tools.managed_tsserver_path


def test_status_preserves_installing_state(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    _mark_typescript_ready(tools)
    tools._state = "installing"

    assert tools.status().state == "installing"


@pytest.mark.asyncio
async def test_install_typescript_verifies_bun_and_disables_package_scripts(
    tmp_path, monkeypatch
):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("bun-linux-x64/bun", b"managed-bun")
    payload = archive.getvalue()
    asset = BunAsset(
        filename="bun-linux-x64.zip",
        url="https://example.invalid/bun.zip",
        sha256=hashlib.sha256(payload).hexdigest(),
        executable_member="bun-linux-x64/bun",
    )
    tools = ManagedLspTools(root=tmp_path / "managed")

    async def fake_download(url: str) -> bytes:
        assert url == asset.url
        return payload

    process = AsyncMock()

    async def finish_install():
        tools.typescript_language_server_path.parent.mkdir(parents=True)
        tools.typescript_language_server_path.write_text("// cli")
        tools.managed_tsserver_path.parent.mkdir(parents=True)
        tools.managed_tsserver_path.write_text("// tsserver")
        return b"", b""

    process.communicate.side_effect = finish_install
    process.returncode = 0
    create_process = AsyncMock(return_value=process)
    monkeypatch.setattr(tools, "_asset", lambda: asset)
    monkeypatch.setattr(tools, "_download", fake_download)
    monkeypatch.setattr(
        "app.services.lsp.managed.asyncio.create_subprocess_exec", create_process
    )

    status = await tools.install_typescript()

    assert status.state == "ready"
    assert tools.bun_path.read_bytes() == b"managed-bun"
    argv = create_process.await_args.args
    assert argv[:2] == (str(tools.bun_path), "install")
    assert "--ignore-scripts" in argv
    assert "--frozen-lockfile" in argv
    assert (
        "typescript-language-server@5.3.0"
        in (tools.packages_dir / "bun.lock").read_text()
    )
    assert '"typescript": "6.0.3"' in (tools.packages_dir / "package.json").read_text()


@pytest.mark.asyncio
async def test_install_typescript_rejects_checksum_mismatch(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    monkeypatch.setattr(
        tools,
        "_asset",
        lambda: BunAsset(
            filename="bun.zip",
            url="https://example.invalid/bun.zip",
            sha256="0" * 64,
            executable_member="bun/bun",
        ),
    )
    monkeypatch.setattr(tools, "_download", AsyncMock(return_value=b"not trusted"))
    create_process = AsyncMock()
    monkeypatch.setattr(
        "app.services.lsp.managed.asyncio.create_subprocess_exec", create_process
    )

    with pytest.raises(ValueError, match="checksum"):
        await tools.install_typescript()

    create_process.assert_not_awaited()
    assert not tools.bun_path.exists()


@pytest.mark.asyncio
async def test_typescript_install_prompt_is_reannounced_after_cooldown(
    tmp_path, monkeypatch
):
    tools = ManagedLspTools(root=tmp_path / "managed")
    publish = AsyncMock()
    times = iter([100.0, 101.0, 401.0])
    monkeypatch.setattr("app.services.lsp.managed.monotonic", lambda: next(times))
    monkeypatch.setattr("app.services.lsp.managed.event_broadcaster.publish", publish)

    await tools.announce_typescript_required(tmp_path)
    await tools.announce_typescript_required(tmp_path)
    await tools.announce_typescript_required(tmp_path)

    assert publish.await_count == 2

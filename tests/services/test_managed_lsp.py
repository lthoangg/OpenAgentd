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
    _executable_name,
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


# ── Managed Python tools (ruff / ty) ────────────────────────────────────────


def _python_wheel_payload(
    name: str,
    version: str,
    *,
    binary: bytes = b"managed-python-binary",
    binary_member: str | None = None,
) -> bytes:
    """Build a fake PyPI wheel zip with the standard script member layout."""
    member = binary_member or f"{name}-{version}.data/scripts/{name}"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(member, binary)
    return buffer.getvalue()


def _pypi_json_response(name: str, version: str, *, digest: str | None = None) -> dict:
    """A PyPI JSON response with one darwin-arm64 and one manylinux wheel."""
    if digest is None:
        digest = hashlib.sha256(_python_wheel_payload(name, version)).hexdigest()
    macos_filename = f"{name}-{version}-py3-none-macosx_11_0_arm64.whl"
    linux_filename = f"{name}-{version}-py3-none-manylinux_2_17_x86_64.whl"
    return {
        "info": {"version": version},
        "urls": [
            {
                "filename": macos_filename,
                "url": f"https://example.invalid/{macos_filename}",
                "digests": {"sha256": digest},
            },
            {
                "filename": linux_filename,
                "url": f"https://example.invalid/{linux_filename}",
                "digests": {"sha256": digest},
            },
        ],
    }


def test_select_python_tool_wheel_prefers_darwin_arm64(monkeypatch):
    from app.services.lsp.managed import _select_python_tool_wheel

    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")
    urls = [
        {
            "filename": "ruff-1.2.3-py3-none-manylinux_2_17_x86_64.whl",
            "url": "u1",
            "digests": {"sha256": "a" * 64},
        },
        {
            "filename": "ruff-1.2.3-py3-none-macosx_11_0_arm64.whl",
            "url": "u2",
            "digests": {"sha256": "b" * 64},
        },
        {
            "filename": "ruff-1.2.3-py3-none-win_amd64.whl",
            "url": "u3",
            "digests": {"sha256": "c" * 64},
        },
    ]

    url, digest = _select_python_tool_wheel("ruff", "1.2.3", urls)

    assert url == "u2"
    assert digest == "b" * 64


def test_select_python_tool_wheel_prefers_musllinux_on_alpine(monkeypatch):
    from app.services.lsp.managed import _select_python_tool_wheel

    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Linux")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "x86_64")
    monkeypatch.setattr(
        "app.services.lsp.managed.platform.libc_ver", lambda: ("musl", "1.2")
    )
    urls = [
        {
            "filename": "ty-1.0.0-py3-none-manylinux_2_17_x86_64.whl",
            "url": "u1",
            "digests": {"sha256": "a" * 64},
        },
        {
            "filename": "ty-1.0.0-py3-none-musllinux_1_2_x86_64.whl",
            "url": "u2",
            "digests": {"sha256": "b" * 64},
        },
    ]

    url, _ = _select_python_tool_wheel("ty", "1.0.0", urls)

    assert url == "u2"


def test_select_python_tool_wheel_windows_amd64(monkeypatch):
    from app.services.lsp.managed import _select_python_tool_wheel

    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Windows")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "AMD64")
    urls = [
        {
            "filename": "ruff-1.2.3-py3-none-win_amd64.whl",
            "url": "u1",
            "digests": {"sha256": "a" * 64},
        },
        {
            "filename": "ruff-1.2.3-py3-none-macosx_11_0_arm64.whl",
            "url": "u2",
            "digests": {"sha256": "b" * 64},
        },
    ]

    url, _ = _select_python_tool_wheel("ruff", "1.2.3", urls)

    assert url == "u1"


def test_select_python_tool_wheel_rejects_unsupported_platform(monkeypatch):
    from app.services.lsp.managed import _select_python_tool_wheel

    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Haiku")
    with pytest.raises(ValueError, match="no ruff 1.2.3 wheel"):
        _select_python_tool_wheel("ruff", "1.2.3", [])


def test_select_python_tool_wheel_rejects_missing_digest(monkeypatch):
    from app.services.lsp.managed import _select_python_tool_wheel

    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")
    urls = [
        {
            "filename": "ruff-1.2.3-py3-none-macosx_11_0_arm64.whl",
            "url": "u1",
            "digests": {},
        }
    ]

    with pytest.raises(ValueError, match="missing sha256"):
        _select_python_tool_wheel("ruff", "1.2.3", urls)


@pytest.mark.asyncio
async def test_install_python_tool_rejects_unsupported_name(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")

    with pytest.raises(ValueError, match="unsupported python tool"):
        await tools.install_python_tool("mypy", "1.0.0")


@pytest.mark.asyncio
async def test_install_python_tool_rejects_malformed_version(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")

    with pytest.raises(ValueError, match="invalid python tool version"):
        await tools.install_python_tool("ruff", "0.16.1; rm -rf /")


@pytest.mark.asyncio
async def test_install_python_tool_extracts_binary_and_verifies_checksum(
    tmp_path, monkeypatch
):
    tools = ManagedLspTools(root=tmp_path / "managed")
    version = "0.16.1"
    payload = _python_wheel_payload("ruff", version)
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        return _pypi_json_response(name, version, digest=digest)

    async def fake_download(url: str) -> bytes:
        assert url.endswith("macosx_11_0_arm64.whl")
        return payload

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    command = await tools.install_python_tool("ruff", version)

    executable = tools.root / "python" / "ruff-0.16.1" / _executable_name("ruff")
    assert command == [str(executable), "server"]
    assert executable.read_bytes() == b"managed-python-binary"
    assert os.name == "nt" or os.access(executable, os.X_OK)


@pytest.mark.asyncio
async def test_install_python_tool_rejects_checksum_mismatch(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    payload = _python_wheel_payload("ruff", "0.16.1")
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        return _pypi_json_response(name, version, digest="0" * 64)

    async def fake_download(url: str) -> bytes:
        return payload

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    with pytest.raises(ValueError, match="checksum"):
        await tools.install_python_tool("ruff", "0.16.1")

    assert not (tools.root / "python" / "ruff-0.16.1").exists()


@pytest.mark.asyncio
async def test_install_python_tool_rejects_wheel_without_script_member(
    tmp_path, monkeypatch
):
    """A wheel whose console-script member is missing must be rejected, not
    partially extracted (zip-slip / structure confusion guard)."""
    tools = ManagedLspTools(root=tmp_path / "managed")
    payload = _python_wheel_payload(
        "ruff", "0.16.1", binary_member="ruff-0.16.1.data/scripts/other"
    )
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        return _pypi_json_response(name, version, digest=digest)

    async def fake_download(url: str) -> bytes:
        return payload

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    with pytest.raises(ValueError, match="does not contain the expected"):
        await tools.install_python_tool("ruff", "0.16.1")

    assert not (tools.root / "python" / "ruff-0.16.1").exists()


@pytest.mark.asyncio
async def test_install_python_tool_resolves_latest_when_unpinned(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    version = "9.9.9"
    payload = _python_wheel_payload("ruff", version)
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")
    seen_versions: list[str | None] = []

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        seen_versions.append(version)
        resolved = version or "9.9.9"  # PyPI latest resolution returns a real version
        return _pypi_json_response(name, resolved, digest=digest)

    async def fake_download(url: str) -> bytes:
        return payload

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    command = await tools.install_python_tool("ruff", None)

    # latest resolution, then the wheel fetch for the resolved version
    assert seen_versions == [None, "9.9.9"]
    assert command == [
        str(tools.root / "python" / "ruff-9.9.9" / _executable_name("ruff")),
        "server",
    ]


@pytest.mark.asyncio
async def test_install_python_tool_is_idempotent_without_force(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    executable = tools.root / "python" / "ruff-0.16.1" / _executable_name("ruff")
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"existing")
    executable.chmod(0o755)

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        raise AssertionError("must not resolve versions when already installed")

    async def fake_download(url: str) -> bytes:
        raise AssertionError("must not download when already installed")

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    command = await tools.install_python_tool("ruff", "0.16.1")

    assert command == [str(executable), "server"]
    assert executable.read_bytes() == b"existing"


@pytest.mark.asyncio
async def test_install_python_tool_prunes_old_versions(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    for version, mtime in (("1.0.0", 1000.0), ("1.1.0", 2000.0)):
        binary = tools.root / "python" / f"ruff-{version}" / _executable_name("ruff")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"x")
        binary.chmod(0o755)
        os.utime(binary.parent, (mtime, mtime))

    payload = _python_wheel_payload("ruff", "1.2.0")
    digest = hashlib.sha256(payload).hexdigest()
    monkeypatch.setattr("app.services.lsp.managed.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.services.lsp.managed.platform.machine", lambda: "arm64")

    async def fake_pypi_json(name: str, version: str | None = None) -> dict:
        return _pypi_json_response(name, version, digest=digest)

    async def fake_download(url: str) -> bytes:
        return payload

    monkeypatch.setattr(tools, "_pypi_json", fake_pypi_json)
    monkeypatch.setattr(tools, "_download", fake_download)

    await tools.install_python_tool("ruff", "1.2.0")

    remaining = sorted(p.name for p in (tools.root / "python").glob("ruff-*"))
    assert remaining == ["ruff-1.1.0", "ruff-1.2.0"]


@pytest.mark.asyncio
async def test_ensure_python_tool_uses_existing_binary_without_installing(
    tmp_path, monkeypatch
):
    tools = ManagedLspTools(root=tmp_path / "managed")
    executable = tools.root / "python" / "ruff-0.16.1" / _executable_name("ruff")
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"x")
    executable.chmod(0o755)

    async def fake_install(name: str, version: str | None, *, force: bool = False):
        raise AssertionError("must not install when binary is present")

    monkeypatch.setattr(tools, "install_python_tool", fake_install)

    command = await tools.ensure_python_tool("ruff", "0.16.1")

    assert command == [str(executable), "server"]


@pytest.mark.asyncio
async def test_ensure_python_tool_installs_when_binary_missing(tmp_path, monkeypatch):
    tools = ManagedLspTools(root=tmp_path / "managed")
    calls: list[tuple[str, str | None]] = []

    async def fake_install(name: str, version: str | None, *, force: bool = False):
        calls.append((name, version))
        executable = (
            tools.root / "python" / f"{name}-{version}" / _executable_name(name)
        )
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"x")
        executable.chmod(0o755)
        return [str(executable), "server"]

    monkeypatch.setattr(tools, "install_python_tool", fake_install)

    command = await tools.ensure_python_tool("ruff", "0.16.1")

    assert calls == [("ruff", "0.16.1")]
    assert command == [
        str(tools.root / "python" / "ruff-0.16.1" / _executable_name("ruff")),
        "server",
    ]


@pytest.mark.asyncio
async def test_ensure_python_tool_returns_none_when_install_fails(
    tmp_path, monkeypatch
):
    """A failed install must degrade silently (manager falls back), never raise."""
    tools = ManagedLspTools(root=tmp_path / "managed")

    async def fake_install(name: str, version: str | None, *, force: bool = False):
        raise RuntimeError("boom")

    monkeypatch.setattr(tools, "install_python_tool", fake_install)

    assert await tools.ensure_python_tool("ruff", "0.16.1") is None


def test_python_tool_command_uses_most_recent_managed_version(tmp_path):
    tools = ManagedLspTools(root=tmp_path / "managed")
    for version, mtime in (("0.15.0", 1000.0), ("0.16.1", 2000.0)):
        binary = tools.root / "python" / f"ty-{version}" / _executable_name("ty")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"x")
        binary.chmod(0o755)
        os.utime(binary.parent, (mtime, mtime))

    assert tools.python_tool_command("ty", None) == [
        str(tools.root / "python" / "ty-0.16.1" / _executable_name("ty")),
        "server",
    ]
    assert tools.python_tool_version("ty") == "0.16.1"

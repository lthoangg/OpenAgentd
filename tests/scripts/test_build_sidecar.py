from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "build_sidecar.py"
    spec = importlib.util.spec_from_file_location("build_sidecar", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_detect_target_triple_supports_windows_x64(monkeypatch):
    module = _load_module()
    monkeypatch.setattr(module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(module.platform, "machine", lambda: "AMD64")

    assert module.detect_target_triple() == "x86_64-pc-windows-msvc"


def test_detect_target_triple_supports_windows_arm64(monkeypatch):
    module = _load_module()
    monkeypatch.setattr(module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(module.platform, "machine", lambda: "ARM64")

    assert module.detect_target_triple() == "aarch64-pc-windows-msvc"


def test_find_and_normalise_windows_python_layout(tmp_path):
    module = _load_module()
    install_root = tmp_path / "install-root"
    source = install_root / "cpython-3.14-windows" / "install"
    source.mkdir(parents=True)
    python_exe = source / "python.exe"
    python_exe.write_bytes(b"python")
    target = tmp_path / "bundle" / "python"

    found = module._find_python_binary(install_root, "3.14")
    assert found == python_exe

    normalised = module.normalise_python_dir(install_root, target, found)

    assert normalised == target / "python.exe"
    assert normalised.is_file()


def test_normalise_windows_python_when_executable_is_at_install_root(tmp_path):
    module = _load_module()
    install_root = tmp_path / "install-root"
    source = install_root / "cpython-3.14-windows"
    source.mkdir(parents=True)
    python_exe = source / "python.exe"
    python_exe.write_bytes(b"python")
    target = tmp_path / "bundle" / "python"

    normalised = module.normalise_python_dir(install_root, target, python_exe)

    assert normalised == target / "python.exe"
    assert normalised.read_bytes() == b"python"


def test_normalise_rejects_python_outside_install_root(tmp_path):
    module = _load_module()
    install_root = tmp_path / "install-root"
    install_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    python_exe = outside / "python.exe"
    python_exe.write_bytes(b"python")

    with pytest.raises(SystemExit, match="outside install root"):
        module.normalise_python_dir(
            install_root, tmp_path / "bundle" / "python", python_exe
        )


def test_normalise_posix_layout_still_preserves_bin_directory(tmp_path):
    module = _load_module()
    install_root = tmp_path / "install-root"
    source = install_root / "cpython-3.14-linux"
    python_bin = source / "bin" / "python3.14"
    python_bin.parent.mkdir(parents=True)
    python_bin.write_bytes(b"python")
    target = tmp_path / "bundle" / "python"

    normalised = module.normalise_python_dir(install_root, target, python_bin)

    assert normalised == target / "bin" / "python3.14"
    assert normalised.is_file()


def test_python_home_matches_windows_flat_runtime_layout(tmp_path):
    module = _load_module()
    python_bin = tmp_path / "bundle" / "python" / "python.exe"

    assert module._python_home_for(python_bin) == python_bin.parent


def test_python_home_matches_posix_bin_runtime_layout(tmp_path):
    module = _load_module()
    python_bin = tmp_path / "bundle" / "python" / "bin" / "python3.14"

    assert module._python_home_for(python_bin) == python_bin.parent.parent


def test_install_packages_installs_from_lock_not_a_fresh_resolve(tmp_path, monkeypatch):
    """Deps must come from uv.lock so the bundle matches what CI tested.

    Regression guard: the sidecar previously ran ``uv pip install .``, which
    re-resolves at build time. That shipped ``mcp`` 2.0.0 while the lock pinned
    1.28.1, and v2's removal of ``streamablehttp_client`` broke every MCP
    server in a release build that had passed CI.
    """
    module = _load_module()
    calls: list[list[str]] = []
    monkeypatch.setattr(module, "run", lambda cmd, cwd=None: calls.append(list(cmd)))

    module.install_packages(
        python_bin=tmp_path / "python" / "bin" / "python3",
        project_root=tmp_path,
        site_packages=tmp_path / "site-packages",
        extras=[],
    )

    export, deps, project = calls

    # 1. Export the locked set, failing loudly if uv.lock is stale.
    assert export[:2] == ["uv", "export"]
    assert "--frozen" in export
    assert "--no-emit-project" in export

    # 2. Dependencies install from that export, never from a bare ".".
    assert deps[:3] == ["uv", "pip", "install"]
    assert "--requirements" in deps
    assert "." not in deps

    # 3. The project installs without re-resolving its dependencies.
    assert project[:3] == ["uv", "pip", "install"]
    assert "--no-deps" in project
    assert project[-1] == "."


def test_install_packages_forwards_extras_to_export_and_project(tmp_path, monkeypatch):
    """Extras must reach both the locked export and the project install."""
    module = _load_module()
    calls: list[list[str]] = []
    monkeypatch.setattr(module, "run", lambda cmd, cwd=None: calls.append(list(cmd)))

    module.install_packages(
        python_bin=tmp_path / "python" / "bin" / "python3",
        project_root=tmp_path,
        site_packages=tmp_path / "site-packages",
        extras=["extra-one", "extra-two"],
    )

    export, _deps, project = calls

    assert export.count("--extra") == 2
    assert "extra-one" in export and "extra-two" in export
    assert project[-1] == ".[extra-one,extra-two]"

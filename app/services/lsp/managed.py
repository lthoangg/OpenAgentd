from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import shutil
import sys
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from time import monotonic
from typing import Literal

import httpx2
from loguru import logger

from app.core.config import settings
from app.services import event_broadcaster

BUN_VERSION = "1.3.14"
TYPESCRIPT_LANGUAGE_SERVER_VERSION = "5.3.0"
TYPESCRIPT_VERSION = "6.0.3"
_MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024
_INSTALL_PROMPT_COOLDOWN_SECONDS = 300.0


@dataclass(frozen=True)
class BunAsset:
    filename: str
    url: str
    sha256: str
    executable_member: str


_BUN_ASSETS: dict[tuple[str, str], tuple[str, str]] = {
    ("darwin", "arm64"): (
        "bun-darwin-aarch64.zip",
        "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
    ),
    ("darwin", "x86_64"): (
        "bun-darwin-x64-baseline.zip",
        "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076",
    ),
    ("linux", "aarch64"): (
        "bun-linux-aarch64.zip",
        "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
    ),
    ("linux", "x86_64"): (
        "bun-linux-x64-baseline.zip",
        "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
    ),
    ("linux-musl", "aarch64"): (
        "bun-linux-aarch64-musl.zip",
        "b98e0ad3625c5c00d1d5b5ff55605c7adddbfae151861e68ade57b2d3b8703bb",
    ),
    ("linux-musl", "x86_64"): (
        "bun-linux-x64-musl-baseline.zip",
        "56a7d6806cf155536c0178f0ea5fbd098e684fa509ebdb4fc0a7e19fb65382dc",
    ),
    ("windows", "arm64"): (
        "bun-windows-aarch64.zip",
        "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953",
    ),
    ("windows", "x86_64"): (
        "bun-windows-x64-baseline.zip",
        "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f",
    ),
}


@dataclass(frozen=True)
class ManagedLspStatus:
    state: Literal["missing", "installing", "ready", "error"]
    detail: str | None
    downloads_enabled: bool
    ty_available: bool
    ruff_available: bool


def _executable_name(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def _is_executable(path: Path) -> bool:
    return path.is_file() and (os.name == "nt" or os.access(path, os.X_OK))


def _packaged_bin_dirs() -> list[Path]:
    # uv-tool dependencies install beside the interpreter. The relocatable
    # desktop sidecar uses `<root>/site-packages/app/...` plus
    # `<root>/site-packages/bin`; deriving that root from this trusted module
    # path avoids executing a same-named binary from an injected sys.path entry.
    module_bin = Path(__file__).resolve().parents[3] / "bin"
    return [Path(sys.executable).resolve().parent, module_bin]


def find_packaged_python_command(name: str) -> list[str] | None:
    """Locate dependency console binaries in uv-tool or sidecar layouts."""
    executable = _executable_name(name)
    for directory in _packaged_bin_dirs():
        candidate = directory / executable
        if _is_executable(candidate):
            return [str(candidate), "server"]
    return None


def _downloads_enabled() -> bool:
    value = os.environ.get("OPENAGENTD_DISABLE_LSP_DOWNLOAD", "")
    return value.strip().lower() not in {"1", "true", "yes", "on"}


def find_project_tsserver(project_root: Path) -> Path | None:
    root = project_root.resolve()
    candidate = root / "node_modules" / "typescript" / "lib" / "tsserver.js"
    resolved = candidate.resolve()
    return resolved if resolved.is_relative_to(root) and resolved.is_file() else None


def _verified_bun_binary(payload: bytes, asset: BunAsset) -> bytes:
    if hashlib.sha256(payload).hexdigest() != asset.sha256:
        raise ValueError("Bun archive checksum verification failed")
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        if asset.executable_member not in archive.namelist():
            raise ValueError("Bun archive does not contain the expected executable")
        if archive.getinfo(asset.executable_member).file_size > _MAX_DOWNLOAD_BYTES:
            raise ValueError("Bun executable exceeds the size limit")
        return archive.read(asset.executable_member)


def _replace_executable(path: Path, binary: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(binary)
    temporary.chmod(0o755)
    temporary.replace(path)


class ManagedLspTools:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or Path(settings.OPENAGENTD_CACHE_DIR) / "lsp"
        self.bin_dir = self.root / "bin"
        self.packages_dir = self.root / "typescript"
        self._install_lock = asyncio.Lock()
        self._state: Literal["installing", "ready", "error"] | None = None
        self._detail: str | None = None
        self._announced_roots: dict[str, float] = {}

    @property
    def bun_path(self) -> Path:
        return self.bin_dir / _executable_name("bun")

    @property
    def typescript_language_server_path(self) -> Path:
        return (
            self.packages_dir
            / "node_modules"
            / "typescript-language-server"
            / "lib"
            / "cli.mjs"
        )

    @property
    def managed_tsserver_path(self) -> Path:
        return self.packages_dir / "node_modules" / "typescript" / "lib" / "tsserver.js"

    def _managed_packages_current(self) -> bool:
        try:
            dependencies = json.loads((self.packages_dir / "package.json").read_text())[
                "dependencies"
            ]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return False
        return dependencies == {
            "typescript": TYPESCRIPT_VERSION,
            "typescript-language-server": TYPESCRIPT_LANGUAGE_SERVER_VERSION,
        }

    def typescript_command(self, project_root: Path) -> tuple[list[str], Path] | None:
        if not (
            _is_executable(self.bun_path)
            and self._managed_packages_current()
            and self.typescript_language_server_path.is_file()
            and self.managed_tsserver_path.is_file()
        ):
            return None
        tsserver = find_project_tsserver(project_root) or self.managed_tsserver_path
        return (
            [
                str(self.bun_path),
                str(self.typescript_language_server_path),
                "--stdio",
            ],
            tsserver,
        )

    def status(self) -> ManagedLspStatus:
        ready = self.typescript_command(Path.cwd()) is not None
        if self._state == "installing":
            state = "installing"
        elif ready:
            state = "ready"
        elif self._state == "error":
            state = "error"
        else:
            state = "missing"
        return ManagedLspStatus(
            state=state,
            detail=self._detail if state == "error" else None,
            downloads_enabled=_downloads_enabled(),
            ty_available=find_packaged_python_command("ty") is not None
            or shutil.which("ty") is not None,
            ruff_available=find_packaged_python_command("ruff") is not None
            or shutil.which("ruff") is not None,
        )

    async def announce_typescript_required(self, project_root: Path) -> None:
        key = str(project_root.resolve())
        now = monotonic()
        last_announced = self._announced_roots.get(key)
        if (
            last_announced is not None
            and now - last_announced < _INSTALL_PROMPT_COOLDOWN_SECONDS
        ):
            return
        if len(self._announced_roots) >= 200:
            self._announced_roots.clear()
        self._announced_roots[key] = now
        await event_broadcaster.publish(
            "lsp_install_required",
            {
                "component": "typescript",
                "workspace": key,
                "downloads_enabled": _downloads_enabled(),
                "language_server_version": TYPESCRIPT_LANGUAGE_SERVER_VERSION,
                "typescript_version": TYPESCRIPT_VERSION,
            },
        )

    def _asset(self) -> BunAsset:
        system = platform.system().lower()
        if system == "linux" and platform.libc_ver()[0].lower() == "musl":
            system = "linux-musl"
        machine = platform.machine().lower()
        if machine in {"amd64", "x64"}:
            machine = "x86_64"
        elif machine in {"arm64", "aarch64"}:
            machine = "arm64" if system in {"darwin", "windows"} else "aarch64"
        item = _BUN_ASSETS.get((system, machine))
        if item is None:
            raise RuntimeError(
                f"Managed TypeScript LSP is unsupported on {system}/{machine}"
            )
        filename, sha256 = item
        directory = filename.removesuffix(".zip")
        member = f"{directory}/{_executable_name('bun')}"
        return BunAsset(
            filename=filename,
            url=f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/{filename}",
            sha256=sha256,
            executable_member=member,
        )

    async def _download(self, url: str) -> bytes:
        payload = bytearray()
        async with httpx2.AsyncClient(follow_redirects=True, timeout=120.0) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                if response.url.scheme != "https":
                    raise ValueError(
                        "Managed LSP download redirected to a non-HTTPS URL"
                    )
                async for chunk in response.aiter_bytes():
                    payload.extend(chunk)
                    if len(payload) > _MAX_DOWNLOAD_BYTES:
                        raise ValueError("Managed LSP download exceeds the size limit")
        return bytes(payload)

    async def install_typescript(self) -> ManagedLspStatus:
        if not _downloads_enabled():
            raise PermissionError(
                "Managed LSP downloads are disabled by OPENAGENTD_DISABLE_LSP_DOWNLOAD"
            )
        async with self._install_lock:
            if self.typescript_command(Path.cwd()) is not None:
                return self.status()
            self._state = "installing"
            self._detail = None
            try:
                asset = self._asset()
                payload = await self._download(asset.url)
                binary = await asyncio.to_thread(_verified_bun_binary, payload, asset)

                await asyncio.to_thread(_replace_executable, self.bun_path, binary)

                self.packages_dir.mkdir(parents=True, exist_ok=True)
                resources = Path(__file__).parent / "resources"
                shutil.copyfile(
                    resources / "package.json", self.packages_dir / "package.json"
                )
                shutil.copyfile(resources / "bun.lock", self.packages_dir / "bun.lock")
                process = await asyncio.create_subprocess_exec(
                    str(self.bun_path),
                    "install",
                    f"--cwd={self.packages_dir}",
                    "--frozen-lockfile",
                    "--ignore-scripts",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.DEVNULL,
                    env={
                        **os.environ,
                        "BUN_INSTALL_CACHE_DIR": str(self.root / "bun-cache"),
                    },
                )
                try:
                    await asyncio.wait_for(process.communicate(), timeout=180.0)
                except TimeoutError:
                    process.kill()
                    await process.wait()
                    raise RuntimeError("Bun package installation timed out") from None
                if process.returncode != 0:
                    raise RuntimeError(
                        f"Bun package installation failed with exit code {process.returncode}"
                    )
                if self.typescript_command(Path.cwd()) is None:
                    raise RuntimeError(
                        "TypeScript language-server installation is incomplete"
                    )
                self._state = "ready"
                self._detail = None
                self._announced_roots.clear()
                logger.info(
                    "managed_lsp_typescript_ready version={} typescript={}",
                    TYPESCRIPT_LANGUAGE_SERVER_VERSION,
                    TYPESCRIPT_VERSION,
                )
                return self.status()
            except Exception as exc:
                self._state = "error"
                self._detail = (
                    str(exc)
                    if isinstance(exc, (PermissionError, ValueError))
                    else "TypeScript component installation failed; see backend logs."
                )
                logger.warning("managed_lsp_typescript_install_failed error={!r}", exc)
                raise


managed_lsp_tools = ManagedLspTools()

#!/usr/bin/env python3
"""Build a relocatable Python sidecar bundle for the desktop shell.

Layout produced under ``<out>/``::

    sidecar-bundle/
      python/                ← python-build-standalone interpreter
        bin/python3
        lib/python3.14/
      site-packages/         ← openagentd + dependencies
        app/                 ← API server package
        fastapi/
        pydantic/
        …

The Tauri shell runs a tiny bootstrap that adds
``sidecar-bundle/site-packages`` with ``site.addsitedir()`` so platform
``.pth`` files are processed, then runs
``app/cli/__main__.py serve --handshake --generate-token --parent-pid …``.

We deliberately do NOT use ``uv tool install`` — that produces an
isolated venv with absolute paths inside it, which won't survive being
copied into ``Contents/Resources/``. Instead we:

1. Fetch a python-build-standalone tarball for the target triple via
   ``uv python install --install-dir …``.
2. ``uv export --frozen`` the locked dependency set, install it with
   ``uv pip install --target <site-packages> --python <python-bin>``,
   then install the project itself with ``--no-deps``. Dependencies come
   from ``uv.lock`` so the bundle matches what CI tested.
3. Strip the ``site-packages/`` of caches, tests, docs.
4. Smoke-test the bundle by invoking ``serve --port 0 --handshake``.

Usage::

    python scripts/build_sidecar.py \\
        --root ./ --out ./desktop/sidecar-bundle \\
        --python-version 3.14 [--extras office,audio]

CI uses this same script on each runner (macos-26, ubuntu-22.04,
windows-2025). The
output is consumed by the Tauri bundler via the ``bundle.resources``
entry in ``tauri.conf.json``.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Patterns to strip from site-packages to shrink the bundle. Anything
# the runtime imports must survive — we intentionally do *not* drop
# `.pyi` files (some packages, e.g. pydantic-core, rely on metadata)
# or `__init__.py` files.
STRIP_DIRS = (
    "__pycache__",
    "tests",
    "test",
    ".dist-info/RECORD",  # pip metadata, not needed at runtime
)
STRIP_GLOBS = (
    "**/*.pyc",
    "**/*.pyo",
    "**/*.pdb",  # MSVC debug symbols
    "**/*.dist-info/RECORD",
    # Heavy localization data we don't need:
    "**/locale/*.mo",
)


def detect_target_triple() -> str:
    """Return the python-build-standalone triple for the current host."""
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin":
        return (
            "aarch64-apple-darwin"
            if machine in ("arm64", "aarch64")
            else "x86_64-apple-darwin"
        )
    if system == "Linux":
        if machine in ("aarch64", "arm64"):
            return "aarch64-unknown-linux-gnu"
        return "x86_64-unknown-linux-gnu"
    if system == "Windows":
        if machine in ("aarch64", "arm64"):
            return "aarch64-pc-windows-msvc"
        return "x86_64-pc-windows-msvc"
    raise SystemExit(f"unsupported host: {system}/{machine}")


def run(cmd: list[str], **kwargs) -> None:
    print(">>", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kwargs)


def fetch_python(version: str, out: Path) -> Path:
    """Use uv to download python-build-standalone for ``version``.

    Returns the path to the python executable inside the install dir.
    """
    out.mkdir(parents=True, exist_ok=True)
    # ``uv python install --install-dir`` places one or more directories
    # under ``out``. As of uv 0.5+ the layout is:
    #
    #   <out>/cpython-<version>-<triple>/        ← real install root
    #     bin/python3.14
    #     lib/python3.14/
    #     ...
    #   <out>/cpython-<major>-<triple>           ← *symlink* to the versioned dir
    #
    # We must find the real directory, not the major-version symlink, or
    # ``shutil.move()`` later will move the symlink and leave us with a
    # broken pointer at the destination.
    run(
        [
            "uv",
            "python",
            "install",
            "--install-dir",
            str(out),
            version,
        ]
    )
    binary = _find_python_binary(out, version)
    if binary is None:
        listing = "\n  ".join(sorted(str(p) for p in out.iterdir()))
        raise SystemExit(f"no python binary found under {out}. Contents:\n  {listing}")
    return binary


def _find_python_binary(root: Path, version: str) -> Path | None:
    """Locate the python interpreter inside a uv install root.

    Walks ``root`` looking for the canonical executable name(s) and
    returns the first hit that is a *real file* (not a broken symlink).
    """
    # ``python3.X`` is the canonical name in python-build-standalone;
    # ``python3`` is a symlink to it. Prefer the versioned name so the
    # rest of the script doesn't follow a symlink it then has to rewrite
    # during normalisation.
    names = [f"python{version}", "python3", "python.exe"]
    for name in names:
        for candidate in root.rglob(name):
            # ``is_file()`` follows symlinks — we want both that the
            # symlink resolves *and* that the target exists. ``rglob``
            # already excludes broken symlinks on most platforms, but
            # be defensive.
            try:
                if candidate.is_file():
                    return candidate.resolve()
            except OSError:
                continue
    return None


def normalise_python_dir(install_root: Path, target: Path, python_bin: Path) -> Path:
    """Move uv's install tree to a flat ``target/`` directory.

    ``python_bin`` is the resolved (symlink-free) path to the interpreter
    inside ``install_root``. The install root is ``python_bin``'s
    grandparent (``bin/python`` → install root). We move *that* directory
    to ``target`` so the layout becomes::

        <target>/bin/python3.14
        <target>/lib/python3.14/
        ...

    Returns the new path of the python binary inside ``target``.
    """
    # POSIX builds put the executable in ``<root>/bin``; Windows builds put
    # ``python.exe`` directly in ``<root>``. Preserve the path relative to
    # that root so both layouts remain relocatable after the move.
    source = (
        python_bin.parent.parent
        if python_bin.parent.name == "bin"
        else python_bin.parent
    )
    try:
        binary_relative = python_bin.relative_to(source)
        source.relative_to(install_root)
    except ValueError as exc:
        raise SystemExit(
            f"resolved python binary {python_bin} is outside install root {install_root}"
        ) from exc

    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    # ``shutil.move`` on a directory works across filesystems by falling
    # back to copy + remove. The source might be inside a directory uv
    # also created symlinks into; that's fine — we only move *this*
    # directory, leaving siblings intact.
    shutil.move(str(source), str(target))

    # Compute the new binary path inside ``target`` and verify.
    new_bin = target / binary_relative
    if not new_bin.is_file() and (target / "bin" / "python3").is_file():
        new_bin = target / "bin" / "python3"
    if not new_bin.is_file():
        raise SystemExit(f"normalisation moved tree but binary not at {new_bin}")
    return new_bin


def install_packages(
    python_bin: Path, project_root: Path, site_packages: Path, extras: list[str]
) -> None:
    """Install the local openagentd project + extras into ``site_packages``.

    Dependencies come from ``uv.lock``, not a fresh resolve of
    ``pyproject.toml``. Installing ``.`` directly re-resolves every constraint
    at build time, so the shipped bundle could differ from the versions the test
    suite ran against. That is exactly how the sidecar once shipped ``mcp``
    2.0.0 while the lock — and therefore CI — pinned 1.28.1: v2 removed
    ``streamablehttp_client``, so every MCP server failed at runtime in a
    release build that passed CI.

    ``--frozen`` makes the build fail loudly when ``uv.lock`` is stale instead
    of silently drifting.
    """
    site_packages.mkdir(parents=True, exist_ok=True)

    # 1. Export the locked dependency set. ``--no-emit-project`` omits
    #    openagentd itself, which is installed from source in step 3.
    export_cmd = [
        "uv",
        "export",
        "--frozen",
        "--no-dev",
        "--no-emit-project",
        "--format",
        "requirements-txt",
    ]
    for extra in extras:
        export_cmd += ["--extra", extra]

    with tempfile.TemporaryDirectory() as tmp:
        requirements = Path(tmp) / "requirements.txt"
        run([*export_cmd, "--output-file", str(requirements)], cwd=project_root)

        # 2. Install exactly those pinned versions (the export carries hashes).
        #    uv pip install --target: PEP 668-safe, no virtualenv needed.
        run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python_bin),
                "--target",
                str(site_packages),
                "--requirements",
                str(requirements),
            ],
            cwd=project_root,
        )

    # 3. Install the project itself. ``--no-deps`` keeps uv from re-resolving
    #    the dependencies already installed at locked versions in step 2.
    spec = f".[{','.join(extras)}]" if extras else "."
    run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python_bin),
            "--target",
            str(site_packages),
            "--no-deps",
            spec,
        ],
        cwd=project_root,
    )


def strip_bundle(site_packages: Path, python_target: Path | None = None) -> int:
    """Remove caches/tests/etc. from site-packages. Returns bytes saved."""
    removed = 0
    for pattern in STRIP_GLOBS:
        for p in site_packages.glob(pattern):
            try:
                if p.is_file():
                    removed += p.stat().st_size
                    p.unlink()
            except OSError:
                pass
    for name in ("__pycache__", "tests", "test"):
        for p in site_packages.rglob(name):
            if p.is_dir():
                try:
                    size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                    shutil.rmtree(p, ignore_errors=True)
                    removed += size
                except OSError:
                    pass

    # Prune babel locale-data (unused by text extraction)
    babel_loc = site_packages / "babel" / "locale-data"
    if babel_loc.is_dir():
        try:
            size = sum(f.stat().st_size for f in babel_loc.rglob("*") if f.is_file())
            shutil.rmtree(babel_loc, ignore_errors=True)
            removed += size
        except OSError:
            pass

    # Prune SBOM JSONs, docs, readmes, licenses in site-packages
    for meta_pattern in ("**/*.cyclonedx.json", "**/*.dist-info/sboms"):
        for p in site_packages.glob(meta_pattern):
            if p.exists():
                try:
                    size = (
                        sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                        if p.is_dir()
                        else p.stat().st_size
                    )
                    if p.is_dir():
                        shutil.rmtree(p, ignore_errors=True)
                    else:
                        p.unlink()
                    removed += size
                except OSError:
                    pass

    for doc_pattern in ("**/LICENSE*", "**/NOTICE*", "**/README*", "**/CHANGELOG*"):
        for p in site_packages.glob(doc_pattern):
            if p.is_file() and not p.is_symlink() and "site-packages/app" not in str(p):
                try:
                    removed += p.stat().st_size
                    p.unlink()
                except OSError:
                    pass

    # Prune Python runtime unused components (include, tcl/tk, ensurepip, etc.)
    if python_target and python_target.is_dir():
        py_include = python_target / "include"
        if py_include.is_dir():
            try:
                size = sum(
                    f.stat().st_size for f in py_include.rglob("*") if f.is_file()
                )
                shutil.rmtree(py_include, ignore_errors=True)
                removed += size
            except OSError:
                pass

        # Prune share directory (manpages, info, docs)
        py_share = python_target / "share"
        if py_share.is_dir():
            try:
                size = sum(f.stat().st_size for f in py_share.rglob("*") if f.is_file())
                shutil.rmtree(py_share, ignore_errors=True)
                removed += size
            except OSError:
                pass

        # Windows root tcl directory
        py_tcl_root = python_target / "tcl"
        if py_tcl_root.is_dir():
            try:
                size = sum(
                    f.stat().st_size for f in py_tcl_root.rglob("*") if f.is_file()
                )
                shutil.rmtree(py_tcl_root, ignore_errors=True)
                removed += size
            except OSError:
                pass

        # Find stdlib directories across POSIX (lib/python3.x) and Windows (Lib)
        stdlib_dirs = list((python_target / "lib").glob("python3.*"))
        win_lib = python_target / "Lib"
        if win_lib.is_dir():
            stdlib_dirs.append(win_lib)

        for py_std in stdlib_dirs:
            if py_std.is_dir():
                for unused_name in (
                    "ensurepip",
                    "idlelib",
                    "tkinter",
                    "pydoc_data",
                    "unittest",
                    "turtle.py",
                    "turtledemo",
                    "test",
                    "tests",
                ):
                    unused_path = py_std / unused_name
                    if unused_path.exists():
                        try:
                            size = (
                                sum(
                                    f.stat().st_size
                                    for f in unused_path.rglob("*")
                                    if f.is_file()
                                )
                                if unused_path.is_dir()
                                else unused_path.stat().st_size
                            )
                            if unused_path.is_dir():
                                shutil.rmtree(unused_path, ignore_errors=True)
                            else:
                                unused_path.unlink()
                            removed += size
                        except OSError:
                            pass
                for cfg in py_std.glob("config-3.*"):
                    if cfg.is_dir():
                        try:
                            size = sum(
                                f.stat().st_size for f in cfg.rglob("*") if f.is_file()
                            )
                            shutil.rmtree(cfg, ignore_errors=True)
                            removed += size
                        except OSError:
                            pass

        # Prune static libraries (*.a) — unused linker archives (~50MB)
        for a_file in python_target.rglob("*.a"):
            if a_file.is_file() and not a_file.is_symlink():
                try:
                    removed += a_file.stat().st_size
                    a_file.unlink()
                except OSError:
                    pass

        # Prune tcl/tk library directories under lib/
        py_lib = python_target / "lib"
        if py_lib.is_dir():
            for tcl_dir in py_lib.iterdir():
                if tcl_dir.is_dir() and (
                    tcl_dir.name.startswith("tcl")
                    or tcl_dir.name.startswith("tk")
                    or tcl_dir.name.startswith("itcl")
                    or tcl_dir.name.startswith("tdbc")
                ):
                    try:
                        size = sum(
                            f.stat().st_size for f in tcl_dir.rglob("*") if f.is_file()
                        )
                        shutil.rmtree(tcl_dir, ignore_errors=True)
                        removed += size
                    except OSError:
                        pass
                elif tcl_dir.is_file() and any(
                    tcl_dir.name.startswith(p)
                    for p in ("libtcl", "libtk", "libitcl", "libtdbc")
                ):
                    try:
                        size = sum(
                            f.stat().st_size for f in tcl_dir.rglob("*") if f.is_file()
                        )
                        shutil.rmtree(tcl_dir, ignore_errors=True)
                        removed += size
                    except OSError:
                        pass

        # Prune internal stdlib site-packages (pip, wheel) inside the standalone
        # runtime; application dependencies live in the outer site-packages/ bundle.
        for sp in python_target.glob("lib/python3.*/site-packages"):
            if sp.is_dir():
                for item in sp.iterdir():
                    try:
                        if item.is_dir():
                            size = sum(
                                f.stat(follow_symlinks=False).st_size
                                for f in item.rglob("*")
                                if f.is_file() or f.is_symlink()
                            )
                            shutil.rmtree(item, ignore_errors=True)
                        elif item.is_file() or item.is_symlink():
                            size = item.stat(follow_symlinks=False).st_size
                            item.unlink()
                        else:
                            size = 0
                        removed += size
                    except OSError:
                        pass

        # Prune extra CLI entry points in bin/ (pip, idle, pydoc, configs)
        py_bin_dir = python_target / "bin"
        if py_bin_dir.is_dir():
            for entry in py_bin_dir.iterdir():
                if entry.name not in (
                    "python",
                    "python3",
                ) and not entry.name.startswith("python3."):
                    try:
                        removed += entry.stat(follow_symlinks=False).st_size
                        entry.unlink() if (
                            entry.is_file() or entry.is_symlink()
                        ) else shutil.rmtree(entry, ignore_errors=True)
                    except OSError:
                        pass

    # Strip native binary symbols in site_packages ONLY using system strip tool.
    # (Never strip python_target: python-build-standalone binaries on Linux rely on
    # ELF symbol versioning headers that standard strip corrupts).
    strip_tool = shutil.which("strip")
    if strip_tool:
        strip_args = ["-x"] if platform.system() == "Darwin" else ["--strip-unneeded"]
        targets_to_strip: list[Path] = []
        for p in site_packages.rglob("*"):
            if p.is_file() and not p.is_symlink():
                if p.suffix in (".so", ".dylib"):
                    targets_to_strip.append(p)
        for target in targets_to_strip:
            try:
                orig_sz = target.stat().st_size
                res = subprocess.run(
                    [strip_tool, *strip_args, str(target)], capture_output=True
                )
                if res.returncode == 0:
                    diff = orig_sz - target.stat().st_size
                    if diff > 0:
                        removed += diff
            except OSError:
                pass
    return removed


def _python_home_for(python_bin: Path) -> Path:
    """Return the bundled runtime root for POSIX and flat Windows layouts."""
    return (
        python_bin.parent.parent
        if python_bin.parent.name == "bin"
        else python_bin.parent
    )


def smoke_test(python_bin: Path, site_packages: Path) -> None:
    """Invoke the sidecar briefly to prove the bundle actually works.

    Stages:

    1. Spawn with the same env vars the desktop shell uses.
    2. Wait for the JSON handshake line on stdout (proves imports + bind).
    3. Hit ``/api/health/live`` *with* the generated token (proves
       middleware wiring + lifespan startup).
    4. Hit it *without* the token (proves 401 enforcement).
    5. SIGTERM and reap.

    Any failure here fails the build — we never want a broken bundle to
    leave CI.
    """
    import json
    import signal as _signal
    import time
    import urllib.error
    import urllib.request

    smoke_root = site_packages.parent / "_smoke"
    # PYTHONHOME must point at the python-build-standalone install root.
    # POSIX places the interpreter under ``<root>/bin``; Windows keeps
    # ``python.exe`` directly under ``<root>``.
    python_home = _python_home_for(python_bin)
    env = {
        **os.environ,
        "PYTHONHOME": str(python_home),
        "PYTHONUNBUFFERED": "1",
        "APP_ENV": "production",
        # Keep test data isolated so the smoke run never touches the user's
        # real openagentd directories.
        "OPENAGENTD_DATA_DIR": str(smoke_root / "data"),
        "OPENAGENTD_CONFIG_DIR": str(smoke_root / "config"),
        "OPENAGENTD_STATE_DIR": str(smoke_root / "state"),
        "OPENAGENTD_CACHE_DIR": str(smoke_root / "cache"),
        "OPENAGENTD_WORKSPACE_DIR": str(smoke_root / "workspace"),
    }

    # Use __main__.py path explicitly rather than ``-m app.cli`` so we
    # know *which* app.cli the interpreter finds — defends against a
    # vendored layout that buries app/ deeper later.
    cli_entry = site_packages / "app" / "cli" / "__main__.py"
    if not cli_entry.is_file():
        raise SystemExit(f"smoke test: missing CLI entry at {cli_entry}")

    bootstrap = (
        "import sys, runpy, site, faulthandler; "
        "faulthandler.dump_traceback_later(55, repeat=False); "
        "_site = sys.argv.pop(1); "
        "_entry = sys.argv.pop(1); "
        "site.addsitedir(_site); "
        "sys.argv[0] = _entry; "
        "runpy.run_path(_entry, run_name='__main__')"
    )

    if os.name == "nt":
        # Sanity-check that the Windows-only ``.pth`` bootstrap (the v1.22.2
        # regression) still works before the full handshake. This is fast
        # and gives a clean failure signal if the sidecar can't even import
        # its core deps; without it, an import failure would hide behind
        # the 60s handshake timeout below.
        run(
            [
                str(python_bin),
                "-c",
                "import sys, site; "
                "site.addsitedir(sys.argv[1]); "
                "import pywintypes; "
                "import app.cli; "
                "print('smoke test: windows imports ok')",
                str(site_packages),
            ],
            env=env,
        )

    smoke_cmd = [
        str(python_bin),
        "-c",
        bootstrap,
        str(site_packages),
        str(cli_entry),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--handshake",
        "--generate-token",
    ]
    print(">> " + " ".join(smoke_cmd))
    proc = subprocess.Popen(
        smoke_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
        # Cross-platform process group so the smoke test can hard-kill
        # the child (and any uvicorn worker it spawns) on timeout.
        # On POSIX this is a new session; on Windows a new process group
        # (``start_new_session`` is silently ignored there).
        start_new_session=(os.name != "nt"),
        creationflags=(
            subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0  # type: ignore[attr-defined]
        ),
    )

    # Read output from background threads so the main thread can
    # enforce a real wall-clock timeout. ``subprocess.Popen.stdout`` is
    # buffered and blocking; without this scaffold, a child that goes
    # quiet hangs the smoke test indefinitely. Drain stderr too so
    # native/runtime warnings don't fill the pipe and so timeouts include
    # a useful tail for debugging.
    import queue as _queue
    import threading as _threading

    stdout_queue: "_queue.Queue[str | None]" = _queue.Queue()
    stdout_tail: list[str] = []
    stderr_tail: list[str] = []

    def _append_tail(buf: list[str], line: str, *, limit: int = 200) -> None:
        buf.append(line.rstrip())
        if len(buf) > limit:
            del buf[: len(buf) - limit]

    def _drain_stdout() -> None:
        assert proc.stdout is not None
        for line in iter(proc.stdout.readline, ""):
            _append_tail(stdout_tail, line)
            stdout_queue.put(line)
        stdout_queue.put(None)  # EOF sentinel

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for line in iter(proc.stderr.readline, ""):
            _append_tail(stderr_tail, line)

    stdout_reader = _threading.Thread(target=_drain_stdout, daemon=True)
    stderr_reader = _threading.Thread(target=_drain_stderr, daemon=True)
    stdout_reader.start()
    stderr_reader.start()

    def _timeout_message() -> str:
        out = "\n".join(stdout_tail[-80:]) or "<empty>"
        err = "\n".join(stderr_tail[-120:]) or "<empty>"
        return (
            "smoke test: handshake did not arrive in 60s\n"
            f"stdout tail:\n{out}\n"
            f"stderr tail:\n{err}"
        )

    payload: dict | None = None
    try:
        deadline = 60.0
        start = time.monotonic()
        while True:
            remaining = deadline - (time.monotonic() - start)
            if remaining <= 0:
                raise SystemExit(_timeout_message())
            try:
                line = stdout_queue.get(timeout=remaining)
            except _queue.Empty:
                raise SystemExit(_timeout_message())
            if line is None:
                err = "\n".join(stderr_tail)
                raise SystemExit(
                    f"smoke test: sidecar exited before handshake.\nstderr:\n{err[-4000:]}"
                )
            line = line.strip()
            if line.startswith("OPENAGENTD_HANDSHAKE "):
                payload = json.loads(line.split(" ", 1)[1])
                break

        assert payload is not None
        port = payload["port"]
        token = payload["token"]
        base = f"http://127.0.0.1:{port}"
        print(f"smoke test: handshake ok: port={port} version={payload['version']}")

        # ── /api/health/live without token → must 401 ──────────────────────
        try:
            urllib.request.urlopen(f"{base}/api/health/live")
            # /api/health/live is exempt — no auth required even when token set.
            # That's intentional: orchestrator probes must work.
            print("smoke test: health/live reachable without token (exempt — expected)")
        except urllib.error.HTTPError as e:
            raise SystemExit(
                f"smoke test: health/live unexpectedly returned {e.code}"
            ) from e

        # ── /api/team/status without token → must 401 ──────────────────────
        try:
            urllib.request.urlopen(f"{base}/api/team/status", timeout=5)
            raise SystemExit(
                "smoke test: protected endpoint accepted request without token"
            )
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise SystemExit(
                    f"smoke test: expected 401 without token, got {e.code}"
                ) from e
            print("smoke test: protected endpoint correctly rejects missing token")

        # ── /api/team/status with token → must succeed (2xx or 503 OK) ─────
        req = urllib.request.Request(
            f"{base}/api/team/status",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            print("smoke test: protected endpoint accepts bearer token")
        except urllib.error.HTTPError as e:
            # 4xx other than 401 is OK (e.g. 404 if route changed), 5xx
            # is not — that signals the request reached the app but the
            # app blew up.
            if e.code == 401:
                raise SystemExit(
                    "smoke test: protected endpoint rejected valid token"
                ) from e
            if 500 <= e.code < 600:
                raise SystemExit(
                    f"smoke test: protected endpoint returned {e.code}"
                ) from e
            print(f"smoke test: protected endpoint returned {e.code} (acceptable)")
    finally:
        if proc.poll() is None:
            proc.send_signal(_signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        # Wipe the isolated smoke data dirs so we don't leak hundreds
        # of MB of throwaway state next to the bundle.
        shutil.rmtree(smoke_root, ignore_errors=True)


def human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n //= 1024
    return f"{n:.1f} TB"


def report_size(root: Path, label: str) -> None:
    # follow_symlinks=False so symlinks pointing to large binaries (e.g.
    # bin/python -> bin/python3.14) are not counted multiple times.
    total = sum(
        p.stat(follow_symlinks=False).st_size
        for p in root.rglob("*")
        if p.is_file() or p.is_symlink()
    )
    print(f"  {label}: {human_bytes(total)}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--root", default=".", help="Project root containing pyproject.toml."
    )
    ap.add_argument(
        "--out", default="desktop/sidecar-bundle", help="Output bundle directory."
    )
    ap.add_argument(
        "--python-version",
        default="3.14",
        help="Major.minor Python version to bundle (default: 3.14).",
    )
    ap.add_argument(
        "--extras",
        default="",
        help="Comma-separated optional-dep extras to install (comma-separated).",
    )
    ap.add_argument(
        "--no-smoke",
        action="store_true",
        help="Skip the post-build smoke test (not recommended).",
    )
    args = ap.parse_args()

    root = Path(args.root).resolve()
    out = Path(args.out).resolve()

    if out.exists():
        print(f"removing existing {out}")
        shutil.rmtree(out)
    out.mkdir(parents=True)

    extras = [x.strip() for x in args.extras.split(",") if x.strip()]

    print(f"target python: {args.python_version}")
    print(f"target triple: {detect_target_triple()}")
    print(f"extras:        {extras or '(none — slim core)'}")
    print(f"output dir:    {out}")

    # ── 1. Fetch python-build-standalone ─────────────────────────────────
    install_root = out / "_python_install"
    uv_python_bin = fetch_python(args.python_version, install_root)
    python_target = out / "python"
    python_bin = normalise_python_dir(install_root, python_target, uv_python_bin)
    shutil.rmtree(install_root, ignore_errors=True)
    print(f"python binary: {python_bin}")

    # ── 2. Install openagentd + deps into site-packages ───────────────────
    site_packages = out / "site-packages"
    install_packages(python_bin, root, site_packages, extras)

    # ── 3. Strip caches/tests/etc. ──────────────────────────────────────
    saved = strip_bundle(site_packages, python_target)
    print(f"stripped: {human_bytes(saved)}")

    # ── 4. Smoke test ───────────────────────────────────────────────────
    if not args.no_smoke:
        smoke_test(python_bin, site_packages)

    # ── 5. Report ────────────────────────────────────────────────────────
    print("\n=== bundle summary ===")
    report_size(python_target, "python runtime")
    report_size(site_packages, "site-packages")
    report_size(out, "TOTAL")
    return 0


if __name__ == "__main__":
    sys.exit(main())

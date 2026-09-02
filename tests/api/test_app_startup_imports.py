"""Regression: importing the FastAPI app must not pull in optional native deps.

On some Windows hosts ``onnxruntime`` (transitively imported by optional
media-processing packages such as ``markitdown``) fails its DLL initialization routine.
Any module that imports those packages at top level therefore kills the
sidecar before it can serve the handshake, leaving the desktop tray stuck on
``Status: Error``.

These imports must stay strictly lazy.  The check runs in a fresh subprocess
because the broader test suite legitimately imports optional media modules in
other tests, polluting :data:`sys.modules` for in-process assertions.
"""

from __future__ import annotations

import subprocess
import sys

_FORBIDDEN_MODULES = [
    "onnxruntime",
    "ctranslate2",
    "av",
    "markitdown",
    # Not native, but ~320 ms of a ~1 s sidecar cold import and only needed
    # once web_fetch converts HTML. Keeping it deferred is a desktop
    # time-to-ready win, so guard it like the native deps.
    "trafilatura",
]


def test_app_import_does_not_load_optional_native_deps() -> None:
    """``import app.api.app`` must not transitively import optional native deps."""
    script = (
        "import sys\n"
        "import app.api.app  # noqa: F401\n"
        f"for module in {_FORBIDDEN_MODULES!r}:\n"
        "    assert module not in sys.modules, "
        "f'app.api.app eagerly imported {module}'\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        "app.api.app leaked an optional native dependency.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )

"""Module entry point so ``python -m app.cli`` works.

This is what the desktop sidecar invokes — see ``desktop/src-tauri/src/sidecar.rs``.
The console-script ``openagentd`` defined in ``pyproject.toml`` calls the
same :func:`app.cli.main.main` function via a generated wrapper, but the
desktop shell can't rely on a wrapper script existing on PATH inside a
bundled site-packages directory.

Stdio prime
===========

The ``sys.stderr.write`` + ``flush`` below look pointless but are not.

On at least two independent Windows MSI installs of 1.22.6 we observed
the sidecar reach lifespan completion (``scheduler_started`` logged to
``backend.log``) without the handshake line ever appearing on Tauri's
stdout pipe — manifesting as the tray going ``starting → error`` with
``timed out waiting for handshake`` in the desktop log.

The same install, after **any** save of ``__main__.py`` via Notepad (even
restoring byte-identical content), started working reliably.  We could
not pin the root cause to file metadata, ACLs, ADS streams, line endings,
encoding, or ``__pycache__`` content — all of those matched the working
state.  The minimal change that consistently resolved the symptom was
performing a single stdio write very early in the entrypoint, before
any imports.

The leading theory is that Python's auto-detected stdio buffering mode
on Windows under ``CREATE_NO_WINDOW`` + ``Stdio::piped()`` can end up
in a state where the first write is delayed long enough to exceed
Tauri's handshake timeout.  Issuing an immediate flush forces
``sys.stderr`` (and indirectly ``sys.stdout``) into a known-good state
before the heavy lifespan work begins.

We write to stderr rather than stdout because the desktop shell
multiplexes those:

- stderr is redirected directly to ``backend.log`` via ``Stdio::from(File)``
  — so this line is captured cleanly in the log for forensics.
- stdout is piped through Tauri's reader and used for the handshake
  line — writing here keeps stdout reserved exclusively for the
  ``OPENAGENTD_HANDSHAKE`` protocol.

If you delete these lines and the bug returns, please re-add them
rather than chase the root cause again — we have a real datapoint
that this fixes user-visible failures, and so far no datapoint that
contradicts it.  (Originally shipped in v1.22.7, stripped when Windows
support was dropped, restored with the Windows desktop revival.)
"""

from __future__ import annotations

import sys as _sys

_sys.stderr.write("openagentd: sidecar bootstrap\n")
_sys.stderr.flush()

from app.cli.main import main  # noqa: E402 — see "Stdio prime" in module docstring.

if __name__ == "__main__":
    main()

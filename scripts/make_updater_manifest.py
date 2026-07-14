#!/usr/bin/env python3
"""Generate the ``latest.json`` updater manifest for Tauri's built-in updater.

The Tauri updater hits the URL configured in ``tauri.conf.json``'s
``plugins.updater.endpoints`` and expects a JSON document of the form::

    {
      "version": "0.6.0",
      "notes": "...",
      "pub_date": "2026-05-15T10:00:00Z",
      "platforms": {
        "darwin-aarch64": {
          "signature": "<contents of .sig file>",
          "url": "https://.../OpenAgentd.app.tar.gz"
        },
        "linux-x86_64": {
          "signature": "<.sig contents>",
          "url": "https://.../OpenAgentd_0.6.0_amd64.AppImage"
        },
        "windows-x86_64": {
          "signature": "<.sig contents>",
          "url": "https://.../OpenAgentd_0.6.0_x64-setup.exe"
        }
      }
    }

We map artefacts found in ``--artefact-dir`` to platform keys by filename
heuristic. The signature files are produced by ``cargo tauri build`` when
``TAURI_SIGNING_PRIVATE_KEY`` is set in the environment.

Channels (``stable`` / ``beta`` / ``nightly``) all currently publish to
the same ``latest.json``; the channel is recorded in the manifest as a
top-level field so the client can ignore mismatched-channel manifests.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

# (filename-suffix → platform-key) priority order: pick the FIRST match
# because we want .app.tar.gz on macOS (the Tauri updater format) and
# .AppImage on Linux, not the .dmg / .deb.
PLATFORM_RULES: list[tuple[str, str]] = [
    (".app.tar.gz", "darwin-aarch64"),
    (".AppImage", "linux-x86_64"),
    ("-setup.exe", "windows-x86_64"),
    (".msi", "windows-x86_64"),
]


def _release_base_url(version: str, tag: str) -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "lthoangg/openagentd")
    return f"https://github.com/{repo}/releases/download/{tag}"


def _read_signature(artefact: Path) -> str:
    sig_path = artefact.parent / f"{artefact.name}.sig"
    if not sig_path.is_file():
        raise ValueError(f"missing updater signature for {artefact.name}")
    signature = sig_path.read_text().strip()
    if not signature:
        raise ValueError(f"empty updater signature in {sig_path.name}")
    return signature


def _build_platforms(artefact_dir: Path, base_url: str) -> dict[str, dict[str, str]]:
    platforms: dict[str, dict[str, str]] = {}
    files = sorted(p for p in artefact_dir.iterdir() if p.is_file())
    for f in files:
        for suffix, key in PLATFORM_RULES:
            if not f.name.endswith(suffix):
                continue
            if key in platforms:
                continue  # already chose a preferred artefact for this platform
            platforms[key] = {
                "url": f"{base_url}/{f.name}",
                "signature": _read_signature(f),
            }
            break
    return platforms


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--version", required=True, help="Version string (e.g. 0.6.0).")
    ap.add_argument(
        "--channel", default="stable", choices=["stable", "beta", "nightly"]
    )
    ap.add_argument("--artefact-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument(
        "--tag",
        default=None,
        help="GitHub release tag (defaults to v<version>).",
    )
    ap.add_argument(
        "--require-platform",
        action="append",
        help="Platform key that must be present; may be passed more than once.",
    )
    args = ap.parse_args()

    tag = args.tag or f"v{args.version}"
    base_url = _release_base_url(args.version, tag)

    try:
        platforms = _build_platforms(args.artefact_dir, base_url)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not platforms:
        print(
            f"error: no updater artefacts matched in {args.artefact_dir}",
            file=sys.stderr,
        )
        return 1

    missing_platforms = sorted(set(args.require_platform or []) - set(platforms))
    if missing_platforms:
        print(
            f"error: missing required updater platform(s): {', '.join(missing_platforms)}",
            file=sys.stderr,
        )
        return 1

    manifest = {
        "version": args.version,
        "channel": args.channel,
        "pub_date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": f"OpenAgentd Desktop {args.version} — see release notes on GitHub.",
        "platforms": platforms,
    }

    args.out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {args.out} with {len(platforms)} platform(s): {sorted(platforms)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

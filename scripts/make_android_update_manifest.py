#!/usr/bin/env python3
"""Write the Android in-app update feed (``latest.json``).

The mobile shell (``mobile/src-tauri/src/updater.rs``) fetches this file from
the rolling ``latest-android`` GitHub release, compares ``version`` with its
own, downloads ``url`` (the immutable ``v<X.Y.Z>`` APK asset), and refuses
to open the installer unless the download matches ``sha256``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def build_manifest(*, apk: Path, version: str, url: str, notes: str, now: dt.datetime) -> dict:
    if not VERSION_RE.match(version):
        raise SystemExit(f"error: not a release version: {version!r}")
    if not url.startswith("https://"):
        raise SystemExit(f"error: download URL must be https: {url!r}")
    data = apk.read_bytes()
    return {
        "version": version,
        "pub_date": now.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": notes.strip(),
        "url": url,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--download-url", required=True)
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    notes = args.notes_file.read_text(encoding="utf-8") if args.notes_file and args.notes_file.is_file() else ""
    manifest = build_manifest(
        apk=args.apk,
        version=args.version,
        url=args.download_url,
        notes=notes,
        now=dt.datetime.now(dt.timezone.utc),
    )
    args.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

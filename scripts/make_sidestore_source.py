#!/usr/bin/env python3
"""Generate the SideStore / AltStore source feed for the iOS sideload build.

SideStore and AltStore Classic read an AltStore-format "source" JSON
(https://faq.altstore.io/developers/make-a-source). Users add its URL once and
then see new versions as in-app updates. The feed lives on the rolling
``latest-ios`` GitHub release; each entry's ``downloadURL`` points at the
immutable ``v<X.Y.Z>`` release asset.

SideStore refuses an install whose entitlements or ``*UsageDescription``
privacy keys differ from what the source lists, so every app field is read
from the built IPA's own ``Info.plist`` rather than maintained by hand.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import plistlib
import re
import sys
import zipfile
from pathlib import Path

REPO_URL = "https://github.com/lthoangg/openagentd"
ICON_URL = (
    "https://raw.githubusercontent.com/lthoangg/openagentd/main/"
    "documents/assets/brand/openagentd-app-icon.png"
)
TINT_COLOR = "#3F3429"
MAX_VERSIONS = 10
INFO_PLIST_RE = re.compile(r"^Payload/[^/]+\.app/Info\.plist$")


def read_info_plist(ipa: Path) -> dict:
    """Return the main app bundle's Info.plist from an IPA."""
    try:
        with zipfile.ZipFile(ipa) as archive:
            names = [name for name in archive.namelist() if INFO_PLIST_RE.match(name)]
            if not names:
                raise SystemExit(f"error: {ipa} has no Payload/*.app/Info.plist")
            return plistlib.loads(archive.read(names[0]))
    except zipfile.BadZipFile as exc:
        raise SystemExit(f"error: {ipa} is not a zip archive: {exc}") from exc


def load_previous_versions(path: Path | None) -> list[dict]:
    """Return the version entries of an earlier feed, or [] when unavailable."""
    if path is None or not path.is_file():
        return []
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
        versions = previous["apps"][0]["versions"]
    except (ValueError, KeyError, IndexError, TypeError):
        return []
    return [entry for entry in versions if isinstance(entry, dict)]


def build_source(
    *,
    info: dict,
    version: str,
    download_url: str,
    size: int,
    date: str,
    notes: str,
    entitlements: list[str],
    previous_versions: list[dict],
) -> dict:
    built_version = info.get("CFBundleShortVersionString")
    if built_version != version:
        raise SystemExit(
            f"error: IPA version {built_version} does not match release version {version}"
        )
    bundle_id = info["CFBundleIdentifier"]

    entry = {
        "version": version,
        "buildVersion": str(info.get("CFBundleVersion", version)),
        "date": date,
        "localizedDescription": notes,
        "downloadURL": download_url,
        "size": size,
    }
    if info.get("MinimumOSVersion"):
        entry["minOSVersion"] = str(info["MinimumOSVersion"])

    history = [item for item in previous_versions if item.get("version") != version]
    versions = [entry, *history][:MAX_VERSIONS]

    privacy = {
        key: value
        for key, value in sorted(info.items())
        if key.endswith("UsageDescription") and isinstance(value, str)
    }

    app = {
        "name": "OpenAgentd",
        "bundleIdentifier": bundle_id,
        "developerName": "OpenAgentd contributors",
        "subtitle": "OpenAgentd mobile shell for remote API servers.",
        "localizedDescription": (
            "OpenAgentd mobile embeds the shared Web UI and connects to a remote "
            "OpenAgentd API server. Run `agentd server start --public --key --qr` "
            "on your computer, then enter its address and key in Backend connection."
        ),
        "iconURL": ICON_URL,
        "tintColor": TINT_COLOR,
        "category": "developer",
        "versions": versions,
        "appPermissions": {
            "entitlements": sorted(set(entitlements)),
            "privacy": privacy,
        },
    }
    return {
        "name": "OpenAgentd",
        "subtitle": "Sideload builds of the OpenAgentd iOS app.",
        "description": f"Official sideload builds published with each release. Source: {REPO_URL}",
        "iconURL": ICON_URL,
        "website": REPO_URL,
        "tintColor": TINT_COLOR,
        "featuredApps": [bundle_id],
        "apps": [app],
        "news": [],
    }


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the SideStore / AltStore source feed for the iOS IPA."
    )
    parser.add_argument("--ipa", type=Path, required=True, help="Built .ipa file")
    parser.add_argument("--version", required=True, help="Release version, e.g. 3.7.0")
    parser.add_argument("--download-url", required=True, help="Public https URL of the IPA")
    parser.add_argument(
        "--date",
        default=dt.datetime.now(dt.timezone.utc).date().isoformat(),
        help="ISO 8601 release date (default: today, UTC)",
    )
    parser.add_argument("--notes-file", type=Path, help="Release notes shown as What's New")
    parser.add_argument("--previous", type=Path, help="Earlier source.json to keep history from")
    parser.add_argument(
        "--entitlement",
        action="append",
        default=[],
        help="Entitlement present in the signed IPA (repeatable; default none)",
    )
    parser.add_argument("--out", type=Path, required=True, help="Output source.json path")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.download_url.startswith("https://"):
        raise SystemExit("error: --download-url must be an https:// URL")
    if not args.ipa.is_file():
        raise SystemExit(f"error: IPA not found: {args.ipa}")

    notes = args.notes_file.read_text(encoding="utf-8").strip() if args.notes_file else ""
    source = build_source(
        info=read_info_plist(args.ipa),
        version=args.version,
        download_url=args.download_url,
        size=args.ipa.stat().st_size,
        date=args.date,
        notes=notes,
        entitlements=args.entitlement,
        previous_versions=load_previous_versions(args.previous),
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(source, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

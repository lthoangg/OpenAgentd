# Installing OpenAgentd

The macOS app is signed with an Apple Developer ID and notarized by
Apple, so it opens like any other downloaded app. Windows builds are
not signed with an Authenticode certificate yet. This document covers
installing on each supported platform.

## macOS (arm64)

The quickest way is the one-command installer, which downloads the
app and does the steps below for you:

```bash
curl -LsSf https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh
```

From the DMG instead: open the downloaded
**`OpenAgentd_x.y.z_aarch64.dmg`**, drag **OpenAgentd** into
**Applications**, and launch it from Launchpad or Spotlight.

Or with Homebrew:

```bash
brew install --cask lthoangg/tap/openagentd
```

You can check the app yourself; both should report a notarized
Developer ID:

```bash
spctl --assess -vv /Applications/OpenAgentd.app
codesign --verify --deep --strict --verbose=1 /Applications/OpenAgentd.app
```

**Upgrading from an ad hoc signed release (before Developer ID):** macOS
asks once more for access to folders such as Documents, because the app's
signature changed. Releases after that keep the grant.

## Linux (Debian / Ubuntu, x86_64)

Linux releases are one `.deb` package. The one-command installer above
downloads and installs it; or from the downloaded file:

```bash
sudo apt-get install ./OpenAgentd_x.y.z_amd64.deb
```

To update, install the newer `.deb` the same way.

## Verifying the download (all platforms)

Every release publishes a `SHA256SUMS` file. Verify before installing:

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS

The expected hashes are also pinned in the GitHub release notes.

## Uninstall

| Platform | How                                                                  |
|----------|----------------------------------------------------------------------|
| macOS    | Drag `OpenAgentd.app` from `/Applications` to the Trash.             |
| Linux    | `sudo apt remove open-agentd` (`dpkg -l \| grep -i agentd` shows the package name). |

Application data lives under the same XDG paths used by the CLI (these survive uninstall by design):

- Config: `~/.config/openagentd/`
- Data: `~/.local/share/openagentd/`
- Workspace: `~/.local/share/openagentd-workspace/`
- State/logs: `~/.local/state/openagentd/`
- Cache/OAuth: `~/.cache/openagentd/`

Delete those directories manually if you want a clean slate.

## Troubleshooting

### macOS: "OpenAgentd.app is damaged" or "cannot be verified"

Releases are notarized, so this means the copy is not the one we
published: it was modified, or it is an old ad hoc signed release.
Download the latest release again. Do not remove the quarantine flag to
get past it; that skips Gatekeeper's check.

### macOS: app launches but immediately quits

The app was probably modified after download (for example re-signed
without its entitlements). Run the bundled `install.sh` on it: if the
signature no longer verifies it says so, and downloading OpenAgentd
again fixes it.

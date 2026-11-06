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

## Linux (x86_64, arm64)

We ship three artifacts; pick whichever your distro prefers.

### AppImage (universal)

```bash
chmod +x OpenAgentd-x.y.z.AppImage
./install.sh --install ./OpenAgentd-x.y.z.AppImage
```

This installs the binary to `~/.local/bin/openagentd`, drops a
`.desktop` entry under `~/.local/share/applications/`, and registers
the icon with the hicolor theme. No `sudo` required.

If `~/.local/bin` is not on your `$PATH`, the script will print the
exact `export` line to add to your shell rc.

### Debian / Ubuntu (`.deb`)

```bash
sudo dpkg -i openagentd_x.y.z_amd64.deb
sudo apt-get install -f      # only if dpkg complains about deps
```

### Fedora / RHEL (`.rpm`)

```bash
sudo rpm -Uvh openagentd-x.y.z.x86_64.rpm
```

The `install.sh` helper detects `.deb` / `.rpm` and defers to the
right package manager automatically.

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
| Linux    | Delete `~/.local/bin/openagentd` and `~/.local/share/applications/openagentd.desktop`. Or `sudo apt remove openagentd` if you used the system package. |

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

### Linux: "openagentd: command not found" after install

`~/.local/bin` isn't on your `$PATH`. Add to `~/.bashrc` /
`~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Reload your shell. Or just launch from the desktop menu.

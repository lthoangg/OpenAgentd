# Installing OpenAgentd

OpenAgentd is not signed with a paid Apple Developer ID or Windows
certificate yet. There's no malware here, but the operating systems
we ship for still treat such software with suspicion. This document
explains the one-time steps required on each supported platform.

## macOS (arm64)

The quickest way is the one-command installer, which downloads the
app and does the steps below for you:

```bash
curl -LsSf https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh
```

From the DMG instead:

1. Open the downloaded **`OpenAgentd_x.y.z_aarch64.dmg`** and drag
   **OpenAgentd** into **Applications**.
2. In Terminal, run the installer bundled inside the app:

   ```bash
   /Applications/OpenAgentd.app/Contents/Resources/install.sh /Applications/OpenAgentd.app
   ```

   It removes the `com.apple.quarantine` flag the browser added and
   verifies the app's signature. It does not re-sign the app.

3. Launch **OpenAgentd** from Launchpad / Spotlight.

**Why is this necessary?** Without a paid Apple Developer ID, the
release is signed ad hoc. Gatekeeper reports a downloaded ad hoc app
as *"OpenAgentd.app is damaged and can't be opened"*, which is not
true; removing the quarantine flag clears it.

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

### macOS: "the developer cannot be verified"

You didn't right-click → Open on first launch. Run:

```bash
xattr -dr com.apple.quarantine /Applications/OpenAgentd.app
```

and try again.

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

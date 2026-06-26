# Installing OpenAgentd

OpenAgentd ships as an **unsigned** desktop application. There's no
malware here — we just haven't paid Apple for code-signing
certificates yet — but the operating systems we currently ship for
still treat unsigned software with suspicion. This document explains
the one-time steps required on each supported platform.

## macOS (arm64)

1. Open the downloaded **`OpenAgentd-x.y.z.dmg`** by double-clicking it.
2. Open **`Terminal`** from the DMG (or your own Terminal app) and
   run:

   ```bash
   /Volumes/OpenAgentd/install.sh --install
   ```

   The script will:
   - Strip the `com.apple.quarantine` xattr that the browser added.
   - Ad-hoc codesign the bundle locally (no Apple ID required).
   - Verify the signature.
   - Copy `OpenAgentd.app` into `/Applications/`.

3. Launch **OpenAgentd** from Launchpad / Spotlight. The first time
   you run it, **right-click → Open** and confirm the prompt.
   macOS will remember the consent.

**Why is this necessary?** Without a paid Apple Developer ID, the
DMG comes through unsigned. Gatekeeper then reports
*"OpenAgentd.app is damaged and can't be opened"* — which is a lie,
but the only way to clear it is to either pay Apple $99/year or
ad-hoc sign the bundle on your own machine. We chose option B for
v1; option A may come later.

**Already have an Apple Developer ID and want to re-sign with it?**
The script refuses to overwrite an existing signature; pass
`--force` to clobber.

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

Most likely a native dependency failed JIT initialization because the
`com.apple.security.cs.allow-unsigned-executable-memory` entitlement got
stripped. Re-run `install.sh` — it re-applies the correct entitlements every
time.

### Linux: "openagentd: command not found" after install

`~/.local/bin` isn't on your `$PATH`. Add to `~/.bashrc` /
`~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Reload your shell. Or just launch from the desktop menu.

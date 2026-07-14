# Distribution coverage

Tracks package-manager channels we've **deliberately deferred** and the
conditions under which it would be worth revisiting them. The goal is
not to ship to every channel — it's to make the cost/benefit explicit
so the decision can be revisited without re-doing the analysis.

For the channels we **do** ship today, see [`documents/docs/install.md`](../docs/install.md).

## Current coverage

| Channel | Status |
|---|---|
| PyPI (`pip`, `pipx`, `uv tool install`) | Shipped, automated |
| Homebrew **formula** (CLI) | Shipped, automated |
| Homebrew **cask** (macOS app, Apple Silicon) | Shipped, automated |
| `install.sh` (curl-pipe, macOS/Linux) | Shipped, static |
| Desktop `.dmg` / `.AppImage` / `.deb` | Shipped, automated |
| Windows desktop `.msi` | Shipped, automated (x64) |

## Recently restored

### Windows desktop (`.msi`)

**Status:** Restored in v1.105.0 with a native x64 release leg, bundled
Python sidecar smoke test, Windows Rust CI, MSI updater manifest entry, Job
Object cleanup, and PowerShell/cmd shell selection. The remaining distribution
gap is an Authenticode certificate; unsigned builds can trigger SmartScreen.

### Docker / GHCR

**Status:** Removed in v1.23.0. The `Dockerfile`,
`docker-compose.yaml`, `docker-compose.local.yaml`, `.dockerignore`,
and `.github/workflows/docker.yml` are gone. The
`ghcr.io/lthoangg/openagentd` image is no longer published.

**Why removed:** OpenAgentd's threat model assumes a trusted operator
on a single machine — agents read/write the host filesystem, run shell
commands, and expect persistent local state. The container model
forces awkward bind-mounts of the data/config/workspace dirs and
muddies the "your machine, your keys" pitch. We had no validated
self-hoster demand to justify the maintenance.

**When to revisit:** Multiple concrete deployment requests from
teams that want a containerised self-hosted instance, or once we have
a multi-user backend (out of scope today).

## Deferred

### Intel Mac desktop build

**What's missing:** `.github/workflows/release-desktop.yml` builds
`aarch64-apple-darwin` only. Intel Mac users have no native desktop
app — they fall back to the CLI (`brew install lthoangg/tap/openagentd`) and the
web cockpit.

**Cost to add:** ~10 minutes extra CI per release (one `macos-13`
runner with `x86_64-apple-darwin` target), one extra matrix entry,
update the cask to drop `depends_on arch: :arm64`.

**When worth doing:**
- Any concrete user report ("I have an Intel MacBook and want the
  desktop app"), **or**
- Telemetry showing >10% of CLI installs come from Intel macOS, **or**
- We add a feature that depends on a desktop-only capability the web
  cockpit can't reach.

Until then, the CLI + web cockpit is a sufficient fallback for Intel.

### Scoop bucket / winget (Windows)

These channels are optional follow-ups now that Windows desktop support is
restored. They are not required for the direct MSI release path.

### AUR (`openagentd-bin`)

**What's missing:** No Arch User Repository package.

**Cost to add:** One `PKGBUILD` that downloads the AppImage (or the
`.deb` extracted), zero CI integration needed — AUR pulls from GitHub
releases directly.

**When worth doing:**
- Wait for a community contributor. Owner-maintained AUR packages are
  a low-leverage commitment; community-maintained ones survive
  longer.
- If we receive a PR or AUR submission request, we should help review
  but not block on it.

### Linux AppImage (regression at 1.0.3)

**What's missing:** `.AppImage` is currently disabled in
`release-desktop.yml` because `linuxdeploy` reliably fails on
GitHub-hosted ubuntu-22.04 runners with a bare "failed to run
linuxdeploy" error that Tauri swallows. The `.deb` bundle covers
Debian/Ubuntu users in the meantime.

**Cost to restore:** likely 1–2 hours of debugging. Options:
- Switch the Linux runner to ubuntu-24.04 (linuxdeploy issues are
  partly glibc-version-dependent).
- Run `linuxdeploy` standalone in a verbose step before/after the
  Tauri bundle call so the underlying error surfaces in CI logs.
- Use `mksquashfs --comp xz` directly to assemble the AppImage,
  bypassing the linuxdeploy plugin chain entirely.

**When worth doing:** before the next minor release (1.1) — restoring
AppImage gives us coverage of non-Debian Linux distros (Arch, Fedora,
openSUSE without rpm conversion) that `.deb` doesn't reach.

### Snap / Flatpak

**Skip.** Both require separate publisher accounts and review queues.
Flatpak's sandbox model conflicts with OpenAgentd's "agent reads/writes
your filesystem" core capability — sandbox-bypassing portals would
need to be requested for every tool, and the install UX would be
worse than the AppImage. Snap is shrinking outside Ubuntu and adds an
auto-update layer we don't control.

The AppImage covers ~all glibc 2.28+ distros with zero packaging cost.

### RPM / COPR / Fedora

**Skip for now.** Tauri can emit `.rpm` and we could add it to the
matrix in `release-desktop.yml`, but proper Fedora integration
requires a COPR or RPM Fusion presence with its own review cadence.
The `.AppImage` already runs on Fedora.

**When worth doing:** Concrete user demand from a Fedora user, or if
we ever want to ship to RHEL/Rocky enterprise environments.

## Re-evaluation cadence

Revisit this list at each minor version bump (1.x → 1.(x+1)) or when
distribution-related GitHub issues accumulate. The decisions above are
defensible **today** — they may not be defensible at 2.0.

# OpenAgentd

<p align="center">
  <img src="https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-primary-lockup.png" alt="OpenAgentd" width="760">
</p>

<p align="center">
  <a href="https://github.com/lthoangg/openagentd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/backend-Rust-orange.svg" alt="Rust backend"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19"></a>
  <a href="https://discord.gg/cz6GQHQUMg"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center"><strong>A coding-first workspace for a local coding agent.</strong><br>
Run an agent on your machine, see every tool call and diff, and keep your models, coding sessions, workspaces, and telemetry under your control.</p>

<p align="center">
  <a href="https://openagentd.dev">Website</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="documents/docs/features.md">Features</a> ·
  <a href="https://discord.gg/cz6GQHQUMg">Discord</a> ·
  <a href="https://www.facebook.com/groups/1256361676707935">Facebook Group</a> ·
  <a href="https://github.com/lthoangg/OpenAgentd/issues">Issues</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

![OpenAgentd annotated coding workspace](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-hero-annotated.png)

## Why OpenAgentd

Most coding agents live in a terminal or an editor. OpenAgentd is a coding-first native desktop app and mobile companion where you can run an agent, follow work in real time, inspect what changed, and keep moving without losing context.

- **See the work.** Streamed replies, tool calls, arguments, results, timings, files, diffs, terminal output, and agent status are visible in one interface.
- **Track tasks.** A clean, user-readable taskboard checklist keeps current work and progress visible at a glance.
- **Work in real repositories.** Coding sessions open local folders, support isolated git worktrees, show changes and history, and return language-server diagnostics after edits.
- **Choose your models.** Use your own keys with major cloud and local providers, including Anthropic, OpenAI, Gemini, OpenRouter, Bedrock, Copilot, Codex, Ollama, and more.
- **Stay local-first.** Sessions, telemetry, configuration, and the API server run on your machine. Connect a mobile client or another desktop securely when you need to.

The versioned [feature catalogue](documents/docs/features.md) is the canonical record of shipped capabilities.

## Get started

### Desktop app

Install the current desktop release:

```bash
# macOS / Linux
curl -fsSL https://openagentd.dev/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://openagentd.dev/install.ps1 | iex
```

On macOS you can also install it with Homebrew:

```bash
brew install --cask lthoangg/tap/openagentd
```

Open **OpenAgentd** from your applications folder or Start menu. The desktop app runs its bundled backend automatically. Add a provider key in Settings, or run local models with Ollama, to start your first conversation.

Release artifacts are available for macOS, Windows, and Linux on the [latest release page](https://github.com/lthoangg/openagentd/releases/latest). Unsigned desktop builds may require an explicit operating-system confirmation before first launch.

### iOS app

The iOS app connects to an OpenAgentd server running on your computer (see
[CLI server](#cli-server)). It is not on the App Store; each release includes an
`.ipa` to sideload. With [SideStore](https://sidestore.io), add this source to
get the app and its updates:

```text
https://github.com/lthoangg/openagentd/releases/download/latest-ios/source.json
```

See [Install the iOS app](mobile/INSTALL-IOS.md) for SideStore setup, other
sideloading tools, free Apple Account limits, connecting to your server, and
troubleshooting.

### Android app

The Android app connects to an OpenAgentd server running on your computer, the
same way as the iOS app. It isn't on Google Play. Each release includes an
`OpenAgentd_<version>_Android.apk` you install directly on the phone (Android
7.0+, 64-bit ARM). See [Install the Android app](mobile/INSTALL-ANDROID.md) for
installing, updating, connecting to your server, and troubleshooting.

### CLI server

Install the backend when you want to run it from a terminal, use a browser client, or connect another device:

```bash
# macOS / Linux
curl -fsSL https://openagentd.dev/install.sh | sh -s -- --cli
openagentd server start
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://openagentd.dev/install.ps1))) -Cli
```

The server creates its default agents and configuration on first start. It
serves the API only: connect to the printed `Server:` address from the desktop
app's server connection dialog or the mobile app, then add a provider in
Settings. To share the desktop app's builtin backend instead, turn on
**Network access** in its Backend connection dialog; no CLI is needed. For a
phone or another computer on your network:

```bash
openagentd server start --host 0.0.0.0 --key
openagentd server status
```

`--key` sets the access key every client must send; the server refuses to
listen beyond loopback without one. It has no built-in TLS, so put an HTTPS
reverse proxy in front of it before exposing it outside a trusted network.
Use `openagentd --help` and `<command> --help` for the current command
reference.

Run one agent turn directly against the current project directory when you need
a pipe-friendly terminal response:

```bash
openagentd run --model openai:gpt-5.5 --thinking high --prompt "Summarize this project"
openagentd run --continue --prompt "Now add tests for it"
```

The command validates the current directory as a coding workspace, persists a
new session for the turn, and streams the agent's response text to standard
output. Tool-permission events follow the runtime's existing auto-allow policy;
interactive agent questions stop the non-interactive command. Use `-C DIR` for
another workspace, `--continue` or `--session ID` to continue a session, and
`--json` for one JSON line per stream event.

### From source

Requires a Rust toolchain (`cargo`) and Bun:

```bash
git clone https://github.com/lthoangg/openagentd.git
cd openagentd
bun install --cwd web
make dev       # backend on :8000 + web UI on http://localhost:5173
```

`make run` starts only the backend.

## What it feels like

| A conversation that can act | A workspace that stays in view |
| --- | --- |
| ![A lead agent combining reports from explorer and researcher helpers](documents/assets/readme/cockpit-split-view-light.png) | ![Coding workspace with the agent's steps and a Git panel of changed files](documents/assets/readme/coding-workspace-light.png) |

| Inspect changes | Keep an eye on local usage |
| --- | --- |
| ![Inline diff inspector](documents/assets/readme/coding-diff-view-light.png) | ![Telemetry summary](documents/assets/readme/telemetry-summary-light.png) |

| Command and scheduling | Todos and terminal |
| --- | --- |
| ![Command palette](documents/assets/readme/command-palette-light.png) ![Scheduler panel](documents/assets/readme/scheduler-light.png) | ![Todos panel](documents/assets/readme/todos-panel-light.png) ![Terminal emulator](documents/assets/readme/terminal-emulator-light.png) |

| Provider and security settings | MCP settings |
| --- | --- |
| ![Providers settings](documents/assets/readme/settings-providers-light.png) ![Denied paths settings](documents/assets/readme/settings-sandbox-light.png) | ![MCP settings](documents/assets/readme/settings-mcp-light.png) |

### Built for the whole loop

**Plan and code.** Toggle between Plan mode for read-only exploration and decision-complete plans, and Code mode for surgical implementation—switch mid-session right from the composer or with `Tab`.

**Build and inspect.** Attach files, browse a coding workspace, use `@` mentions, review real-time diffs, and inspect structured tool output without leaving the conversation. Delegate independent sub-tasks across specialists with a unified timeline.

**Operate with confidence.** Manage providers, MCP servers, skills, path denylist permissions, scheduled tasks, todos, and local telemetry from the coding workspace. OpenAgentd supports desktop, browser, and touch-first mobile clients against the same API.

## For users and contributors

- [Features](documents/docs/features.md) — shipped, version-cited capabilities.
- [Releases](https://github.com/lthoangg/openagentd/releases) — download builds and read release notes.
- [Discord](https://discord.gg/cz6GQHQUMg) — join the community server to chat and ask questions.
- [Facebook Group](https://www.facebook.com/groups/1256361676707935) — join the community group to connect and share.
- [Issues](https://github.com/lthoangg/OpenAgentd/issues) — feature requests, bugs, roadmap discussion, and known issues.
- [Security policy](SECURITY.md) — report vulnerabilities privately.
- [Contributing](CONTRIBUTING.md) — set up a development checkout and submit changes.

OpenAgentd is licensed under [Apache 2.0](LICENSE).

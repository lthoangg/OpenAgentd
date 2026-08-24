# OpenAgentd

<p align="center">
  <img src="https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-primary-lockup.png" alt="OpenAgentd" width="760">
</p>

<p align="center">
  <a href="https://github.com/lthoangg/openagentd/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/python-3.14-blue.svg" alt="Python 3.14"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19"></a>
  <a href="https://discord.gg/cz6GQHQUMg"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center"><strong>A local-first cockpit for AI agents.</strong><br>
Run an agent team on your machine, see every tool call and diff, and keep your models, sessions, workspaces, and telemetry under your control.</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="documents/docs/features.md">Features</a> ·
  <a href="https://discord.gg/cz6GQHQUMg">Discord</a> ·
  <a href="https://www.facebook.com/groups/1256361676707935">Facebook Group</a> ·
  <a href="https://github.com/lthoangg/OpenAgentd/issues">Issues</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

![OpenAgentd annotated multi-agent cockpit](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-hero-annotated.png)

## Why OpenAgentd

Most coding agents live in a terminal or an editor. OpenAgentd is the cockpit around them: a native desktop app and mobile companion where you can run a lead with specialists, follow work in real time, inspect what changed, and keep moving without losing context.

- **See the work.** Streamed replies, tool calls, arguments, results, timings, files, diffs, terminal output, and agent status are visible in one interface.
- **Run a team.** A lead can delegate to specialists, coordinate them through an async mailbox, and let you watch individual or unified timelines.
- **Work in real repositories.** Coding sessions open local folders, support isolated git worktrees, show changes and history, and return language-server diagnostics after edits.
- **Choose your models.** Use your own keys with major cloud and local providers, including Anthropic, OpenAI, Gemini, OpenRouter, Bedrock, Copilot, Codex, Ollama, and more.
- **Stay local-first.** Sessions, telemetry, configuration, and the API server run on your machine. Connect a mobile client or another desktop securely when you need to.

The versioned [feature catalogue](documents/docs/features.md) is the canonical record of shipped capabilities.

## Get started

### Desktop app

Install the current desktop release:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/lthoangg/openagentd/main/install.ps1 | iex
```

Open **OpenAgentd** from your applications folder or Start menu. The desktop app runs its bundled backend automatically, and new installations can start a conversation immediately with the keyless OpenCode Zen default. Add another provider in Settings whenever you want to switch models.

Release artifacts are available for macOS, Windows, and Linux on the [latest release page](https://github.com/lthoangg/openagentd/releases/latest). Unsigned desktop builds may require an explicit operating-system confirmation before first launch.

### CLI server

Install the backend when you want to run it from a terminal, use a browser client, or connect another device:

```bash
uv tool install openagentd
openagentd
```

The server creates its default agents and configuration on first start. Open the
printed local address and add a provider in Settings. For a phone or another
computer on your network:

```bash
openagentd server start --lan --key
openagentd server address
openagentd server health
```

`--key` protects non-loopback access. Use `openagentd --help` and `<command> --help` for the current command reference.

### From source

```bash
git clone https://github.com/lthoangg/openagentd.git
cd openagentd
uv sync
bun install --cwd web
make run
```

For frontend development in a second terminal:

```bash
cd web && bun dev
```

## What it feels like

| A conversation that can act | A workspace that stays in view |
| --- | --- |
| ![Split cockpit view with lead and worker agents](documents/assets/readme/cockpit-split-view.png) | ![Coding workspace with files and diffs](documents/assets/readme/coding-workspace.png) |

| Inspect changes | Keep an eye on local usage |
| --- | --- |
| ![Inline diff inspector](documents/assets/readme/coding-diff-view.png) | ![Telemetry summary](documents/assets/readme/telemetry-summary.png) |

### Built for the whole loop

**Plan and delegate.** Ask for a plan before code changes, then let a lead split independent work across specialists. View the unified timeline when you want the story, or focus on one agent when you need detail.

**Build and inspect.** Attach files, browse a coding workspace, use `@` mentions, review real-time diffs, and inspect structured tool output without leaving the conversation.

**Operate with confidence.** Manage providers, MCP servers, skills, path denylist permissions, scheduled tasks, todos, and local telemetry from the cockpit. OpenAgentd supports desktop, browser, and touch-first mobile clients against the same API.

## For users and contributors

- [Features](documents/docs/features.md) — shipped, version-cited capabilities.
- [Releases](https://github.com/lthoangg/openagentd/releases) — download builds and read release notes.
- [Discord](https://discord.gg/cz6GQHQUMg) — join the community server to chat and ask questions.
- [Facebook Group](https://www.facebook.com/groups/1256361676707935) — join the community group to connect and share.
- [Issues](https://github.com/lthoangg/OpenAgentd/issues) — feature requests, bugs, roadmap discussion, and known issues.
- [Security policy](SECURITY.md) — report vulnerabilities privately.
- [Contributing](CONTRIBUTING.md) — set up a development checkout and submit changes.

OpenAgentd is licensed under [Apache 2.0](LICENSE).

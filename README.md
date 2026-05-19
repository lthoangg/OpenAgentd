# OpenAgentd

<p align="center">
  <img src="https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-primary-lockup.png" alt="OpenAgentd octobot mascot and wordmark" width="760">
</p>

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/lthoangg/openagentd/blob/main/LICENSE)
[![Python 3.14](https://img.shields.io/badge/python-3.14-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)

**Your on-machine multi-agent system.** A long-running local service with a web cockpit, persistent memory, and a team of agents that coordinate to get real work done. Everything stays on your hardware.

[Documentation](https://github.com/lthoangg/openagentd/blob/main/documents/docs/index.md) · [Migration](https://github.com/lthoangg/openagentd/blob/main/MIGRATION.md)

![OpenAgentd annotated multi-agent cockpit](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/brand/openagentd-hero-annotated.png)

---

## Screenshots

| Home | Coding workspace |
|---|---|
| ![OpenAgentd home screen with active agent session](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/homepage.png) | ![Coding mode with chat, files, and diff sidebars](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/coding-screen-with-2sidebars.png) |

| Agents settings | Sandbox settings |
|---|---|
| ![Settings page for configuring lead and member agents](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/settings-agents.png) | ![Settings page for filesystem sandbox and permission controls](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/settings-sandbox.png) |

| Voice settings | Telemetry dashboard |
|---|---|
| ![Settings page for local voice transcription](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/settings-voice.png) | ![Telemetry dashboard with traces, tokens, and latency](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/screenshots/telemetry.png) |

---

## What you get

**A cockpit, not a chat box.** Command palette (Ctrl+P), slash commands (`/init`, `/continue`, `/compact`, `/undo`, `/redo`), drag-and-drop files, full-screen image viewer, and an inspector that shows every tool call and what came back.

![Tool call inspector — arguments, execution status, and results](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/tool-call-inspector.png)

**Agents that can actually do things.** Read and write files, run shell commands, search the web, generate images and video, manage todos, schedule tasks. Add more via a skill `.md` or any MCP server.

**A workspace the agent shares with you.** Every file the agent touches shows up in a side panel — browse, preview, download. In `/coding`, open a server-local project folder and review the live file tree plus current git diff, including untracked files, from the same drawer.

**Persistent memory you can edit.** Karpathy-style wiki: `USER.md` is injected into every prompt, session notes feed the dream agent, and durable knowledge is organized into sources, topics, entities, and comparisons. Browse and edit it from the Wiki panel.

**Run a team, not just one agent.** A lead agent spawns specialist instances on demand (`executor#1`, `executor#2`, ...), coordinates through an async mailbox, and can grant/revoke member tools, skills, or MCP servers at runtime. Watch live agents in the default split view, resume interrupted work with `/continue`, or switch to a single unified view.

**Use it as a coding cockpit.** Coding mode ships with a workspace-aware team (`coding/openagentd`, `coding/executor`, `coding/explorer`, `coding/consultant`) that can inspect a local codebase, make changes, run checks, and keep files/diffs visible while it works.

![Unified team view — lead and specialist agents visible together](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/team-unified.png)

**Voice input, transcribed locally.** Click the mic button to record, click again to stop. The recording is transcribed on-device via Whisper and inserted into the chat input for review — nothing leaves your machine. Configure in `speech.yaml` or enable via Settings → Voice.

**Schedule it and walk away.** Cron, interval, or one-shot schedules. Results appear when you come back.

**Track work as a board.** `todo_manage` gives the lead and members a shared task board with assignment, claims, dependencies, priorities, and live UI updates.

**See exactly what the agent is doing.** Built-in OTel dashboard — token usage, latency, trace waterfall. No third-party SaaS, all local.

**Pick your model, no lock-in.** 14 providers — Gemini, OpenAI, OpenRouter, Bedrock, Grok, DeepSeek, Ollama, and more. Switch with one line in your agent config.

---

## Why OpenAgentd

|                      | **openagentd**                        | **opencode**        | **openclaw**      | **hermes-agent**     |
|----------------------|---------------------------------------|---------------------|-------------------|----------------------|
| **UI**               | Web cockpit                           | Terminal            | Messaging apps    | Messaging / CLI      |
| **Memory**           | 3-tier wiki, cross-session, editable  | Session only        | Session only      | Cross-session (FTS5) |
| **Image / video**    | Multi-provider images + native video  | —                   | Via plugins       | Images, no video     |
| **Hot-reload**       | Everything, no restart                | Restart required    | Partial           | MCP only             |
| **Self-modification**| Agent edits its own config            | —                   | Partial           | Persona + skills     |
| **Telemetry**        | Built-in OTel dashboard               | —                   | —                 | —                    |
| **Embed / API**      | First-class REST + SSE                | Protocol only       | Channel-shaped    | Channel-shaped       |

Full breakdown: [`documents/docs/comparison.md`](https://github.com/lthoangg/openagentd/blob/main/documents/docs/comparison.md).

---

## Quick start

**Desktop app** (double-click install, no terminal) — download from the [latest release](https://github.com/lthoangg/openagentd/releases/latest):

| Platform | Artefact | First-launch note |
|---|---|---|
| macOS (Apple Silicon) | `brew install --cask lthoangg/tap/openagentd` *or* `OpenAgentd_*_aarch64.dmg` | The cask ad-hoc signs and installs automatically. With the `.dmg`, run the bundled `install.sh` then right-click → **Open**. The app is unsigned — [why](https://github.com/lthoangg/openagentd/blob/main/documents/docs/install.md#desktop-unsigned). |
| Windows | `OpenAgentd_*_x64-setup.exe` | SmartScreen warns on first run — click **More info → Run anyway**. |
| Linux | `OpenAgentd_*_amd64.AppImage` | `chmod +x` the AppImage, or run the bundled `install.sh --install` for a launcher entry. |

macOS — after mounting the `.dmg`:

```bash
cd /Volumes/OpenAgentd*
./install.sh --install            # ad-hoc signs + copies to /Applications
```

Then right-click **OpenAgentd.app → Open** the first time (single-click won't work).

**CLI / API server** (terminal install — ships the same UI on `http://localhost:4082`):

```bash
# macOS / Linux
uv tool install openagentd        # recommended
brew install lthoangg/tap/openagentd
curl -fsSL https://raw.githubusercontent.com/lthoangg/openagentd/main/install.sh | sh   # zero-setup: bootstraps uv, then installs

# Windows
irm https://raw.githubusercontent.com/lthoangg/openagentd/main/install.ps1 | iex
```

```bash
openagentd init   # pick provider + API key, install default agents
openagentd        # http://localhost:4082
```

![Installing openagentd with uv tool install](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/openagentd-install.gif)

Other install options (pip, pipx, from source) — see [`documents/docs/install.md`](https://github.com/lthoangg/openagentd/blob/main/documents/docs/install.md).

---

## Migrate from OpenClaw or Hermes Agent

Import existing identity and context Markdown files into one OpenAgentd lead agent:

```bash
openagentd migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5
openagentd migrate hermes --from ~/.hermes --model openai:gpt-5.5
```

Existing agent files are not overwritten unless `--force` is passed. See [`MIGRATION.md`](https://github.com/lthoangg/openagentd/blob/main/MIGRATION.md) for setup migration from OpenClaw, Hermes, Claude Code, and Codex CLI.

---

## Providers

Switch models with a single line in your agent's `.md` config file. Every provider uses the `provider:model` format.

| Provider | Format | Auth |
|---|---|---|
| Google Gemini | `googlegenai:gemini-3.1-flash` | `GOOGLE_API_KEY` |
| Google Vertex AI | `vertexai:gemini-3-flash-preview` | `VERTEXAI_API_KEY` or GCP creds |
| OpenAI | `openai:gpt-5.5` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter:qwen/qwen3.6-plus:free` | `OPENROUTER_API_KEY` |
| ZAI / GLM | `zai:glm-5-turbo` | `ZAI_API_KEY` |
| xAI Grok | `xai:grok-4.20` | `XAI_API_KEY` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-6` | AWS profile / default chain |
| NVIDIA NIM | `nvidia:stepfun-ai/step-3.5-flash` | `NVIDIA_API_KEY` |
| GitHub Copilot | `copilot:gpt-5.4-mini` | `openagentd auth copilot` |
| OpenAI Codex | `codex:gpt-5.5` | `openagentd auth codex` |
| 9Router (local) | `router9:cc/claude-sonnet-4-5` | `ROUTER9_API_KEY` (optional `ROUTER9_BASE_URL`) |
| CLIProxyAPI (local) | `cliproxy:gemini-2.5-pro` | `CLIPROXY_API_KEY` (optional `CLIPROXY_BASE_URL`) |
| Ollama (local + cloud) | `ollama:llama3.2` · `ollama:kimi-k2.6-cloud` | none (cloud: `ollama signin`) |

Set a `fallback_model` in your agent config for automatic failover on rate limits or 5xx errors.

---

## Built-in tools

| Category | Tools |
|---|---|
| Filesystem | `read`, `write`, `edit`, `patch`, `ls`, `glob`, `grep`, `rm` |
| Shell | `shell`, `bg` (background processes) |
| Web | `web_search`, `web_fetch` |
| Memory | `wiki_search`, `note` |
| Generation | `generate_image`, `generate_video` |
| Scheduling | `schedule_task` |
| Tasks | `todo_manage` |
| Team coordination | `team_message`, `team_manage`, `team_configure` (teams only) |
| Utility | `date`, `skill` |

Add any MCP server to expose more tools without writing code.

---

## Agents and teams

OpenAgentd ships with one lead agent and three member blueprints:

| Agent | Role | Specialty |
|---|---|---|
| **openagentd** | Lead | Coordinates the team, receives user messages, spawns members, delegates |
| **consultant** | Member blueprint | Architecture reviews, debugging, design decisions (high thinking) |
| **executor** | Member blueprint | File creation, builds, shell commands, tangible artifacts |
| **explorer** | Member blueprint | Web research, codebase exploration, information gathering |

Configure your team by editing `.md` files in your config directory. Exactly one agent must have `role: lead`; the rest are member blueprints. The lead uses `team_manage` to spawn/dismiss live instances (`executor#1`, `explorer#1`), `team_message` to delegate and collect results, and `team_configure` to grant or revoke a member's skills, tools, or MCP servers without restarting.

Fresh installs also seed a separate coding team under `agents/coding/`. Open `/coding` to select a server-local project folder and start workspace-aware sessions; Settings shows those agents as `coding/openagentd`, `coding/executor`, `coding/explorer`, and `coding/consultant`.

![OpenAgentd agent architecture — loop, hooks, tools, providers, memory, and team mode](https://raw.githubusercontent.com/lthoangg/openagentd/main/documents/assets/openagentd-agent-architecture.png)

### Agent config at a glance

```yaml
---
name: my-agent
role: member
description: Handles deep research tasks
model: googlegenai:gemini-3.1-flash
thinking_level: high
fallback_model: openrouter:qwen/qwen3.6-plus:free
tools:
  - web_search
  - web_fetch
  - read
  - note
skills:
  - web-research
mcp:
  - context7
---

System prompt goes here.
```

Member instances are created lazily from `role: member` configs. Re-spawning an explicit handle restores its history for the current lead session; dismissing an instance only removes it from the live roster.

---

## Memory

The wiki is editable and organized around durable, source-linked pages:

1. **`USER.md`** — Pure YAML, always injected into every system prompt. Edit it directly to give the agent standing context about you, your projects, or your preferences.
2. **Knowledge pages** — `sources/`, `topics/`, `entities/`, and `comparisons/`, BM25-searchable via `wiki_search`.
3. **Session notes** — Per-day notes the agent appends to via the `note` tool.

The **dream agent** runs on a cron schedule, reads unprocessed sessions and notes, writes source summaries first, updates related knowledge pages, and refreshes the wiki index - turning ephemeral conversation into durable memory without any action on your part.

---

## Voice input

Click the mic button in the chat input to record. Click again to stop. The recording is transcribed on-device using [Whisper](https://github.com/openai/whisper) and inserted into the input for review — you still press Send manually. Nothing leaves your machine.

**Enable it:** open **Settings → Voice** and toggle it on (or edit `~/.config/openagentd/speech.yaml` directly). `faster-whisper` ships with the default install — no extra to enable.

**`speech.yaml` reference:**

```yaml
voice:
  enabled: true
  model: local:base    # local:base / local:small / local:medium
  language: auto       # or a BCP-47 code: "en", "fr", "ja", …
  max_file_mb: 25
```

The file is hot-reloaded on change — no server restart needed. V1 is local-only (`local:*`). No TTS, no auto-send, no silence auto-stop.

---

## Scheduler

Create tasks that run on a schedule or fire once at a specific time:

- **Cron** — standard five-field cron expressions
- **Interval** — every N seconds, minutes, or hours
- **At** — one-shot at an exact datetime

Tasks appear in the `/scheduler` panel. Pause, resume, or trigger them manually from the UI or via the REST API.

---

## Observability

OpenAgentd exports OpenTelemetry spans to local JSONL partitions and serves a built-in dashboard at `/telemetry`:

- **Summary** — token usage, error rates, latency distribution, model breakdown
- **Trace explorer** — full span waterfall per session, filterable by date range
- **Prometheus endpoint** — `/metrics` for external scraping

No external collector required. All data stays on your machine.

---

## Skills

Skills are `.md` files that inject domain-specific instructions into an agent's context on demand. They ship separately from agent configs, so one skill can be reused by any agent.

Included skills:

| Skill | Purpose |
|---|---|
| `self-healing` | Agent edits its own config (model, tools, skills) |
| `mcp-installer` | Install new MCP servers from the UI or by description |
| `skill-installer` | Install new skills from a URL or from scratch |
| `plugin-installer` | Install agent plugins |
| `web-research` | Structured web research methodology with source citation |

Add your own by dropping a `SKILL.md` file into `{config_dir}/skills/{name}/` or via the `/settings/skills` UI.

---

## MCP servers

OpenAgentd ships with [Context7](https://context7.com) pre-configured. Add any MCP server via the `/settings/mcp` panel or by editing `mcp.json` directly. Changes are hot-reloaded without a restart.

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["my-mcp-package"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  }
}
```

---

## Sandbox and permissions

**Filesystem sandbox** — A denylist blocks access to OpenAgentd's own data, state, and cache directories. Add your own glob patterns (`**/.env`, `**/secrets/**`) in `sandbox.yaml`. Changes take effect immediately, no restart needed.

**Permission system** — By default, tools auto-approve and log. Switch to interactive mode to block on sensitive operations and reply per-request with `once`, `always`, or `reject`. Permission decisions are persisted and replayed across turns.

---

## Documentation

Full documentation index: [`documents/docs/index.md`](https://github.com/lthoangg/openagentd/blob/main/documents/docs/index.md).

### Getting started

| Section | Contents |
|---------|----------|
| [Install](https://github.com/lthoangg/openagentd/blob/main/documents/docs/install.md) | pip, uv, Homebrew, Docker, source |
| [Migration](https://github.com/lthoangg/openagentd/blob/main/MIGRATION.md) | Move setup from OpenClaw, Hermes, Claude Code, Codex CLI, or older OpenAgentd installs |
| [CLI reference](https://github.com/lthoangg/openagentd/blob/main/documents/docs/cli.md) | Every `openagentd` subcommand |
| [Configuration overview](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration.md) | Hub — links into the focused subpages below |
| [Environment variables](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/env.md) | `Settings` fields, provider keys, optional extras |
| [Paths & XDG roots](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/paths.md) | DATA / CONFIG / STATE / CACHE / WORKSPACE / WIKI |
| [LLM providers](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/providers.md) | Every registered prefix, OAuth flows, capability YAML |
| [Agent files](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/agents.md) | `.md` frontmatter schema, validation, editing workflow |
| [Built-in tools](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/tools.md) | Filesystem, shell, web, multimodal, memory |
| [Skills](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/skills.md) | `SKILL.md` format, seeded skill catalog |
| [Sandbox & permissions](https://github.com/lthoangg/openagentd/blob/main/documents/docs/configuration/sandbox.md) | Denylist paths, user `sandbox.yaml`, permission services |
| [Comparison](https://github.com/lthoangg/openagentd/blob/main/documents/docs/comparison.md) | How OpenAgentd compares to opencode, openclaw, hermes-agent |
| [Troubleshooting](https://github.com/lthoangg/openagentd/blob/main/documents/docs/troubleshooting.md) | Common install and runtime issues |

### Architecture & internals

| Section | Contents |
|---------|----------|
| [Architecture](https://github.com/lthoangg/openagentd/blob/main/documents/docs/architecture.md) | C4 diagrams, in-memory SSE streaming, SSE event protocol |
| [Agent engine](https://github.com/lthoangg/openagentd/tree/main/documents/docs/agent) | Loop, hooks, tools, teams, plugins, context, memory, summarization |
| [Lazy team members](https://github.com/lthoangg/openagentd/blob/main/documents/docs/agent/team-lazy-spawn.md) | Spawn/dismiss member instances, `blueprint#N` handles, history restore |
| [API reference](https://github.com/lthoangg/openagentd/blob/main/documents/docs/api/index.md) | HTTP endpoints, SSE events, file handling |

### Operations

| Section | Contents |
|---------|----------|
| [Logging](https://github.com/lthoangg/openagentd/blob/main/documents/docs/logging.md) | App log + per-session JSONL, rotation, console format |
| [Observability](https://github.com/lthoangg/openagentd/blob/main/documents/docs/observability.md) | OTel spans, DuckDB-backed `/api/observability/*`, `/telemetry` UI |
| [Desktop distribution](https://github.com/lthoangg/openagentd/blob/main/documents/docs/desktop.md) | Tauri v2 shell, Python sidecar, token auth, release pipeline |
| [Title generation](https://github.com/lthoangg/openagentd/blob/main/documents/docs/title-generation.md) | LLM-generated session titles, SSE event, config |

### Frontend (`web/`)

| Section | Contents |
|---------|----------|
| [App chrome](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/chrome.md) | Shared header, platform detection, Tauri drag, macOS overlay |
| [Workspace Files](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/workspace-files.md) | Session files, coding Files & Diff, previews, downloads |
| [Todos popover](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/todos.md) | Task board, assignments, claims, dependencies, live updates |
| [Tool rendering](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/tool-results.md) | Tool call/result UI and custom renderers |
| [Chat input & queue](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/chat-input.md) | Consecutive message queuing, `PendingMessageQueue` |
| [Voice input](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/voice-input.md) | Browser mic, local STT, transcript insertion, settings |
| [Mobile layout](https://github.com/lthoangg/openagentd/blob/main/documents/docs/web/mobile.md) | Phone-first responsive design — breakpoints, safe areas |

### Contributing

| Section | Contents |
|---------|----------|
| [Guidelines](https://github.com/lthoangg/openagentd/blob/main/documents/docs/guidelines.md) | Dev commands, code style, testing patterns, GitHub conventions |
| [Team testing](https://github.com/lthoangg/openagentd/blob/main/documents/docs/testing/team.md) | Manual smoke-test recipes for the multi-agent team |

---

## Star History

<a href="https://www.star-history.com/?repos=lthoangg%2Fopenagentd&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lthoangg/openagentd&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lthoangg/openagentd&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lthoangg/openagentd&type=date&legend=top-left" />
 </picture>
</a>

---

## Contributing

See [CONTRIBUTING.md](https://github.com/lthoangg/openagentd/blob/main/CONTRIBUTING.md) for setup, workflow, and PR guidelines.

## Security

See [SECURITY.md](https://github.com/lthoangg/openagentd/blob/main/SECURITY.md) for the trust model and how to report vulnerabilities.

## License

[Apache License 2.0](https://github.com/lthoangg/openagentd/blob/main/LICENSE). Free for personal, research, and commercial use.

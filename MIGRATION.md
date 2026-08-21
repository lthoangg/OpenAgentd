# Migration

Move existing local agent setup from other harnesses into OpenAgentd.

OpenAgentd migration is focused on reusable setup: agent identity, standing instructions, project context, skills/workflows, and provider configuration. It does not import private runtime state from other tools unless explicitly noted.

## What To Migrate

| Source material | OpenAgentd destination |
|-----------------|------------------------|
| Agent identity and behavior prompts | `~/.config/openagentd/agents/<name>.md` |
| Reusable workflows or commands | `~/.config/openagentd/skills/<skill>/SKILL.md` |
| Project-local instructions | Keep as repo `AGENTS.md` for coding mode |
| API keys | `~/.config/openagentd/.env` or **Settings → Providers** |
| OAuth providers | `openagentd auth <provider>` or **Settings → Providers** |

No separate initialization step is required. Application startup creates the
configuration directory and missing built-in agents without overwriting existing
files.

## From OpenClaw

OpenAgentd has a built-in OpenClaw importer through `openagentd migrate`:

```bash
openagentd migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5
```

The importer reads these files when present: `AGENTS.md`, `SOUL.md`, `SOULS.md`, `TOOLS.md`.

It writes one lead agent to `~/.config/openagentd/agents/openclaw.md`. Existing files are not overwritten unless you pass `--force`. The command also supports `--config-dir` for importing into a non-default OpenAgentd config directory.

Use `--name` if you want a different agent filename:

```bash
openagentd migrate openclaw --from ~/my-project --name project-agent --model openai:gpt-5.5
```

## From Hermes Agent

OpenAgentd has a built-in Hermes importer through `openagentd migrate`:

```bash
openagentd migrate hermes --from ~/.hermes --model openai:gpt-5.5
```

The importer reads these files when present: `SOUL.md`, `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`.

It writes one lead agent to `~/.config/openagentd/agents/hermes.md`. Existing files are not overwritten unless you pass `--force`. The command also supports `--config-dir` for importing into a non-default OpenAgentd config directory.

Use `--from` with a project directory if your Hermes context is project-local instead of under `~/.hermes`.

See `openagentd migrate --help` for the full flag reference.

## From Claude Code

There is no automatic Claude Code importer yet. Migrate the durable setup manually:

1. Copy reusable personal instructions from `~/.claude/CLAUDE.md` into `~/.config/openagentd/agents/<name>.md`.
2. Keep project `CLAUDE.md` content as repo-local instructions by moving or copying it to `AGENTS.md` in that project.
3. Move reusable slash-command or workflow text into `~/.config/openagentd/skills/<skill>/SKILL.md`.
4. Configure providers in **Settings → Providers** or `~/.config/openagentd/.env`.

Claude Code credentials and session history are not imported.

## From OpenAI Codex CLI

There is no automatic Codex CLI importer yet. Migrate reusable setup manually:

1. Copy durable instructions from Codex project files into repo `AGENTS.md` for coding mode, or into an OpenAgentd agent file for global behavior.
2. Connect Codex OAuth in OpenAgentd with `openagentd auth codex`, or use **Settings → Providers → OpenAI Codex**.
3. Set agent models to the `codex:` provider prefix when you want to use Codex OAuth-backed models.

Codex CLI credentials are not imported because OpenAgentd stores its own OAuth token at `~/.cache/openagentd/codex_oauth.json`.

## Filesystem Tool Consolidation (v1.134.0)

`write`, `edit`, `ls`, `rm`, and `date` were removed. `read` now lists
directories, and `patch` is the only tool that creates, edits, deletes, or
moves files.

Nothing is required of you: agent files under
`~/.config/openagentd/agents/` that still list a removed tool are pruned
automatically the first time they load, and the agent keeps working in the
meantime.

Two behaviours changed if you relied on them:

| Before | Now |
|--------|-----|
| `rm` with `recursive: true` | run `rm -rf` through the `shell` tool |
| `date` tool for the current time | the UTC date is injected into the prompt each turn; use `shell` with `date` for local wall-clock time |

Custom agents that listed only removed tools fall back to the built-in
defaults for their mode. Skills or plugins whose instructions tell the model
to "use the write tool" should be reworded to reference `patch`.

## Existing OpenAgentd Installs

If you already use OpenAgentd before `1.0.0`, you do not need to uninstall first. Install or update OpenAgentd normally, then launch the desktop app or run `openagentd`.

The CLI and desktop app share the same production paths:

| Data | Path |
|------|------|
| Config, agents, skills, `.env` | `~/.config/openagentd/` |
| SQLite database | `~/.local/share/openagentd/openagentd.db` |
| Session workspaces and uploads | `~/.local/share/openagentd-workspace/` |
| Logs and telemetry | `~/.local/state/openagentd/` |
| Cache and OAuth tokens | `~/.cache/openagentd/` |

Database migrations run automatically on startup. Back up `~/.local/share/openagentd/openagentd.db` before major upgrades if you have important history.

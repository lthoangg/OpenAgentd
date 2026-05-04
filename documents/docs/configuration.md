---
title: Configuration Guide
description: Environment variables, agent setup, tools, skills, sandbox, XDG paths, hooks, running the server.
status: stable
updated: 2026-04-30
---

# Configuration Guide

This document covers everything you need to customise openagentd: environment
variables, agent setup, adding tools, skills, and the sandbox.

---

## Config file location

All settings live in `app/core/config.py` (Pydantic `Settings`).
Copy `.env.example` to the right location and fill in the keys you need.

openagentd uses four XDG-aligned roots, one per category of data:

| Mode | `.env` location | Data | Config | State | Cache |
|------|-----------------|------|--------|-------|-------|
| Production | `~/.config/openagentd/.env` | `~/.local/share/openagentd/` | `~/.config/openagentd/` | `~/.local/state/openagentd/` | `~/.cache/openagentd/` |
| Development | `.env` (project root) | `.openagentd/data/` | `.openagentd/config/` | `.openagentd/state/` | `.openagentd/cache/` |

Both `.env` files are loaded if present — the home-config file takes priority over the project one. All path settings are automatically derived from `APP_ENV`; only set them to override.

What lives where:

- **Data** — irreplaceable user data. DB (`openagentd.db`). Sibling root `workspace/` lives alongside (`OPENAGENTD_WORKSPACE_DIR`). User-uploaded chat attachments live inside `workspace/<sid>/uploads/` so the agent's filesystem tools can reach them as `uploads/<filename>`. **Back this up.**
- **Config** — hand-edited configuration. Agents (`agents/`), skills (`skills/`), prompt overrides (`summarization.md`, `title_generation.md`), multimodal generation (`multimodal.yaml`), `.env`.
- **State** — historical bookkeeping. Logs (`logs/`), telemetry (`telemetry/`), OTEL rollups (`otel/`), `openagentd.pid`. Safe to archive.
- **Cache** — regeneratable throwaway. `quoteoftheday.json`, `copilot_oauth.json` (OAuth token). Safe to delete any time.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `production` | `production` or `development` — controls data directory, log level, and config YAML defaults |
| `GOOGLE_API_KEY` | — | Required for `googlegenai` provider |
| `ZAI_API_KEY` | — | Required for `zai` provider |
| `VERTEXAI_API_KEY` | — | Required for `vertexai` provider |
| `OPENAI_API_KEY` | — | Required for `openai` provider |
| `OPENROUTER_API_KEY` | — | Required for `openrouter` provider |
| `NVIDIA_API_KEY` | — | Required for `nvidia` provider (NVIDIA NIM) |
| `XAI_API_KEY` | — | Required for `xai` provider (xAI Grok) |
| `DEEPSEEK_API_KEY` | — | Required for `deepseek` provider |
| `AWS_BEDROCK_REGION` | — | AWS region for `bedrock` provider. Falls back to `AWS_DEFAULT_REGION` env var, then `us-east-1` |
| `AWS_BEDROCK_PROFILE` | — | Named AWS profile (`~/.aws/credentials`) for `bedrock` provider. Unset = default boto3 credential chain |
| `ROUTER9_API_KEY` | — | Required for `router9` provider ([9Router](https://github.com/decolua/9router) local proxy). Copy from the 9Router dashboard. |
| `ROUTER9_BASE_URL` | `http://localhost:20128/v1` | OpenAI-compatible base URL of your 9Router instance |
| `CLIPROXY_API_KEY` | — | Required for `cliproxy` provider ([CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) local proxy). Use whatever your proxy enforces (any value if auth is disabled). |
| `CLIPROXY_BASE_URL` | `http://localhost:8317/v1` | OpenAI-compatible base URL of your CLIProxyAPI instance |
| `NINJA_API_KEY` | — | Quote of the Day via [API Ninjas](https://api-ninjas.com) (free tier: 3 000 calls/month) |
| — | — | `copilot` provider: run `openagentd auth copilot` (no env var needed) |
| — | — | `codex` provider: run `openagentd auth codex` (no env var needed) |
| `GOOGLE_CLOUD_PROJECT` | — | GCP project ID (Vertex AI normal mode) |
| `GOOGLE_CLOUD_LOCATION` | `global` | GCP region (Vertex AI) |
| `OPENAGENTD_DATA_DIR` | prod: `~/.local/share/openagentd` · dev: `.openagentd/data` | Root for irreplaceable user data (DB). Denied to agent fs tools. |
| `OPENAGENTD_CONFIG_DIR` | prod: `~/.config/openagentd` · dev: `.openagentd/config` | Root for hand-edited config (agents, skills, prompts, `.env`). |
| `OPENAGENTD_STATE_DIR` | prod: `~/.local/state/openagentd` · dev: `.openagentd/state` | Root for logs, telemetry, OTEL rollups, PID file. |
| `OPENAGENTD_CACHE_DIR` | prod: `~/.cache/openagentd` · dev: `.openagentd/cache` | Root for regeneratable throwaway data. |
| `OPENAGENTD_WORKSPACE_DIR` | prod: `~/.local/share/openagentd-workspace` · dev: `.openagentd/workspace` | Per-session agent workspaces (`{root}/<sid>/`). User uploads live at `{root}/<sid>/uploads/`. Allowed by the sandbox. |
| `DATABASE_URL` | `{OPENAGENTD_DATA_DIR}/openagentd.db` | SQLite path or async DB URL |
| `AGENTS_DIR` | `{OPENAGENTD_CONFIG_DIR}/agents` | Directory of per-agent `.md` files |
| `SKILLS_DIR` | `{OPENAGENTD_CONFIG_DIR}/skills` | Directory of skill subdirectories |
| `LOG_LEVEL` | `INFO` | Console log verbosity: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `API_HOST` | `0.0.0.0` | Bind address |
| `API_PORT` | `4082` (8000 on development) | Bind port |
| `CORS_ORIGINS` | `["*"]` | Allowed CORS origins |
| `MULTIMODAL_CONFIG_PATH` | `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml` | Path to the multimodal generation config (image/audio/video sections). Drives `generate_image` and `generate_video`. |
| `OPENAGENTD_WIKI_DIR` | dev: `.openagentd/wiki/` · prod: `~/.local/share/openagentd-wiki/` | Wiki knowledge store (`USER.md`, `topics/`, `notes/`). See [`agent/memory.md`](agent/memory.md). |
> **Service-level defaults (not env vars).** Summarization thresholds, title-generation timeout, tool-result offload sizes, and sandbox limits are module-level constants in their respective service modules — not environment variables. Override them through the file-based / per-agent config surfaces described below (`.openagentd/config/summarization.md`, `.openagentd/config/title_generation.md`, per-agent `.md` frontmatter).

---

## Agent configuration

Each agent is a single `.md` file with YAML frontmatter (config) and a Markdown body (system prompt). Files live in `{OPENAGENTD_CONFIG_DIR}/agents/` by default.

To import OpenClaw or Hermes prompt/context files, run:

```bash
openagentd migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5
openagentd migrate hermes --from ~/.hermes --model openai:gpt-5.5
```

This writes one normal OpenAgentd lead agent at `{OPENAGENTD_CONFIG_DIR}/agents/<name>.md`. Existing files are not replaced unless `--force` is passed. OpenClaw imports `AGENTS.md`, `SOUL.md`, `SOULS.md`, and `TOOLS.md`; Hermes imports `SOUL.md`, `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, and `.cursorrules`.

| Path | Purpose |
|------|---------|
| `{OPENAGENTD_CONFIG_DIR}/agents/*.md` | Per-agent config + system prompt |
| `{OPENAGENTD_CONFIG_DIR}/dream.md` | Dream agent config (`enabled`, `model`, `schedule`, `tools`) — see [`agent/memory.md`](agent/memory.md#dream-agent-config) |
| `{OPENAGENTD_CONFIG_DIR}/summarization.md` | Global summarization defaults (model, thresholds) |
| `{OPENAGENTD_CONFIG_DIR}/title_generation.md` | Global title-generation defaults |
| `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml` | Provider/model config for multimodal generation tools (`generate_image`, `generate_video`; audio reserved) |
| `{OPENAGENTD_CONFIG_DIR}/mcp.json` | MCP client config — see [`agent/tools.md`](agent/tools.md#mcp-servers-appagentmcp) and [`api/index.md`](api/index.md#mcp-server-management) |
| `{OPENAGENTD_CONFIG_DIR}/sandbox.yaml` | User-defined sandbox deny-list (glob patterns, e.g. `**/.env`). Managed via `/settings/sandbox` — see [Sandbox model and permissions](#sandbox-model-and-permissions) |
| `{OPENAGENTD_CONFIG_DIR}/skills/` | Skill subdirectories (`{name}/SKILL.md`) |

### Switching models

Change the `model:` field — no code changes needed:

```yaml
model: googlegenai:gemini-3.1-flash-lite-preview       # Google Developer API
model: googlegenai:gemma-4-31b-it         # Gemma via Google AI Studio
model: vertexai:gemini-3-flash-preview    # Vertex AI (needs GCP creds)
model: zai:glm-5-turbo                    # ZAI / GLM
model: openrouter:qwen/qwen3.6-plus:free  # OpenRouter (any model)
model: nvidia:stepfun-ai/step-3.5-flash   # NVIDIA NIM (any model)
model: openai:gpt-5.5                     # OpenAI — Chat Completions by default; Responses API auto-selected when thinking_level is set
model: copilot:gpt-5.4-mini               # GitHub Copilot (run: openagentd auth copilot)
model: copilot:claude-sonnet-4.6          # GitHub Copilot
model: codex:gpt-5.5                      # OpenAI Codex via ChatGPT subscription (run: openagentd auth codex)
model: xai:grok-4.20                      # xAI Grok 4 (vision-capable)
model: deepseek:deepseek-v4-flash         # DeepSeek (OpenAI-compatible)
model: bedrock:global.anthropic.claude-sonnet-4-6  # AWS Bedrock (global cross-region)
model: bedrock:anthropic.claude-sonnet-4-6         # AWS Bedrock (in-region)
model: bedrock:amazon.nova-pro-v1:0                # AWS Bedrock Nova
model: router9:cc/claude-sonnet-4-5-20250929  # 9Router local proxy (set ROUTER9_API_KEY)
model: cliproxy:gemini-2.5-pro            # CLIProxyAPI local proxy (set CLIPROXY_API_KEY)
```

#### Local proxy providers (`router9`, `cliproxy`)

Both providers talk to a **locally-running OpenAI-compatible proxy** that fans
out to many upstream models. Set the API key (and optionally override the
default port via `*_BASE_URL`) — that's it.

| Provider | Upstream | Default base URL | Vision default |
|----------|----------|------------------|----------------|
| `router9` | [9Router](https://github.com/decolua/9router) — Node.js dashboard, 40+ providers, quota tracking | `http://localhost:20128/v1` | `true` |
| `cliproxy` | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — Go proxy that wraps Gemini CLI / ChatGPT Codex / Claude Code OAuth | `http://localhost:8317/v1` | `true` |

```yaml
model: router9:cc/claude-sonnet-4-5-20250929   # 9Router → Claude Code subscription
model: router9:gc/gemini-3-flash-preview       # 9Router → Gemini CLI free tier
model: cliproxy:gemini-3-flash-preview         # CLIProxyAPI → Gemini CLI OAuth
model: cliproxy:gpt-5.4                        # CLIProxyAPI → ChatGPT Codex OAuth
```

The model id after the prefix is passed verbatim to the proxy — see the
upstream's dashboard / `/v1/models` endpoint for the catalog. If a specific
upstream is text-only, add an exact override to
`app/agent/providers/capabilities.yaml` (see [NVIDIA section](#nvidia-nim-provider)
for the pattern).

If `cliproxy` is run without auth, any non-empty `CLIPROXY_API_KEY` works (the
header is required by the OpenAI client).

#### OpenAI Codex provider

The `codex` provider uses your **ChatGPT Plus/Pro subscription** to access OpenAI models via the Codex-specific endpoint (`https://chatgpt.com/backend-api/codex/responses`). No API key billing — usage is included in your ChatGPT plan.

**Setup:**

```bash
openagentd auth codex            # opens browser (PKCE flow — recommended)
openagentd auth codex --device   # headless device-code flow (SSH / no browser)
```

Credentials are cached at `{OPENAGENTD_CACHE_DIR}/codex_oauth.json` and refreshed automatically. Re-run `openagentd auth codex` if the token expires permanently.

**Example models:**

```yaml
model: codex:gpt-5.4
model: codex:gpt-5.4-mini
model: codex:gpt-5.1-codex
model: codex:gpt-5.1-codex-mini
model: codex:gpt-5.2
```

**Capability defaults:** vision is `false` for all `codex:` models (conservative default). The endpoint is Responses API only — `temperature` and `top_p` are silently ignored. `thinking_level` maps to `reasoning.effort`.

**Notes:**
- Requires an active ChatGPT Plus, Pro, Business, Edu, or Enterprise subscription.
- The system prompt is sent as the `instructions` field (required by the endpoint), not embedded in `input`.
- `model_kwargs.responses_api` is not applicable — the endpoint is always Responses API.
- The same OAuth token also powers `generate_image` when `multimodal.yaml` sets `image.model: codex:<chat-model>` — image generation rides the Responses API via an `image_generation` tool. See [`generate_image` backends](agent/tools.md#multimodalyaml).

---

#### NVIDIA NIM provider

The `nvidia` provider uses NVIDIA's OpenAI-compatible API at
`https://integrate.api.nvidia.com/v1`. It supports any model available on the
[NVIDIA NIM catalog](https://build.nvidia.com/models).

**Setup:**

```bash
# .env
NVIDIA_API_KEY=nvapi-...
```

**Example models:**

```yaml
model: nvidia:stepfun-ai/step-3.5-flash
model: nvidia:meta/llama-3.1-8b-instruct
model: nvidia:nvidia/llama-3.1-nemotron-ultra-253b-v1
model: nvidia:mistralai/mistral-7b-instruct-v0.3
```

The model name after the `nvidia:` prefix is passed verbatim to the API — use
the exact model ID shown in the NIM catalog.

**Capability defaults:** vision is `false` for all `nvidia:` models (conservative
default — the catalog is too varied to assume). If you use a vision-capable NIM
model, it will not receive image attachments from multimodal messages.

To override capabilities for a specific model, add an entry to
`app/agent/providers/capabilities.yaml`. Each entry uses sparse merge — only
specify fields that differ from defaults:

```yaml
"nvidia:nvidia/llama-3.2-90b-vision-instruct":
  input:
    vision: true
```

Defaults and provider-prefix fallbacks are defined in `capabilities.py`.
Capabilities are split into `input` (what the model accepts: `vision`,
`document_text`, `audio`, `video`) and `output` (what it generates: `text`,
`image`, `audio`).

---

#### AWS Bedrock provider

The `bedrock` provider uses the **Converse API** (`boto3 bedrock-runtime`), which works uniformly across all Bedrock model families.

**Auth** (resolved in priority order):
1. Explicit `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars
2. Named profile via `AWS_BEDROCK_PROFILE` (reads `~/.aws/credentials`)
3. Standard boto3 credential chain (instance profile, IAM role, etc.)

**Region** (resolved in priority order): `AWS_BEDROCK_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`

```bash
# .env
AWS_BEDROCK_PROFILE=my-profile   # optional — unset uses default boto3 chain
AWS_BEDROCK_REGION=us-east-1     # optional
```

**Example models:**

```yaml
model: bedrock:global.anthropic.claude-sonnet-4-6      # global cross-region (recommended)
model: bedrock:global.anthropic.claude-opus-4-7
model: bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0
model: bedrock:anthropic.claude-sonnet-4-6             # in-region
model: bedrock:amazon.nova-pro-v1:0
model: bedrock:amazon.nova-lite-v1:0
```

Prefer `global.*` model IDs for higher availability. In-region IDs (without `global.`) pin requests to a single region. See `app/agent/providers/capabilities.yaml` for the full list of vision-capable models.

**Capability defaults:** vision is `false` for the `bedrock:` prefix (too varied). Claude 4.x and Nova Pro/Lite are listed explicitly as vision-capable in `capabilities.yaml`.

**Note on async:** the provider uses `asyncio.to_thread` to wrap boto3's synchronous calls. `aiobotocore` is not used because it does not support Bedrock's event stream format (`converse_stream`).

**Smoke test** (no server required):
```bash
uv run python -m manual.try_providers.try_bedrock --simple
uv run python -m manual.try_providers.try_bedrock --tools
```

---

### Thinking (`thinking_level`)

`thinking_level` enables extended reasoning on models that support it.

| Value | Behaviour |
|-------|-----------|
| `none` (default) | Thinking disabled |
| `low` | Lightweight reasoning pass |
| `medium` | Balanced reasoning |
| `high` | Maximum reasoning effort |

**OpenAI models** — setting any non-`none` `thinking_level` automatically routes the request through the **Responses API** (`/v1/responses`) instead of Chat Completions. This is required because OpenAI's Chat Completions endpoint does not support `reasoning_effort` alongside function tools. The routing is transparent — no extra config needed:

```yaml
# Automatically uses /v1/responses because thinking_level is set
model: openai:gpt-5.4
thinking_level: high
```

To force a specific API regardless of `thinking_level`, use `model_kwargs`:

```yaml
# Force Chat Completions even with thinking (e.g. for compatible third-party endpoints)
model: openai:gpt-5.4
thinking_level: low
model_kwargs:
  responses_api: false

# Force Responses API even without thinking
model: openai:gpt-5.4
model_kwargs:
  responses_api: true
```

**Responses API limitations** — when routed to `/v1/responses`, `temperature` and `top_p` are silently ignored (the API does not accept them). `max_tokens` maps to `max_output_tokens`.

**Other providers** — `thinking_level` maps to each provider's native reasoning parameter (e.g. `thinking: {budget_tokens: ...}` for Anthropic/Copilot Claude models). Non-reasoning models ignore the field.

### `description` field

The `description` field is shown in:
- `GET /agents` API response
- The web UI agent info panel (ⓘ button in ChatView header)

It does **not** affect the system prompt — it's metadata only.

### System prompt

The Markdown body of the agent's `.md` file (everything after the closing `---`) is the system prompt. No separate file needed.

```markdown
---
name: assistant
model: zai:glm-5-turbo
---

You are a helpful assistant. Be concise and direct.
```

### Fallback model

When the primary model fails with retryable errors (429 rate limit, 5xx server errors,
connection timeouts), the agent can automatically switch to a fallback model.

```yaml
model: zai:glm-5v-turbo             # primary model
fallback_model: copilot:gpt-5-mini  # used after primary exhausts retries
```

**Behaviour:**
- The primary model is retried up to 5 times with exponential backoff.
- On the last attempt, no sleep — switches to fallback immediately.
- The fallback model gets its own 5-retry budget with the same backoff.
- Non-retryable errors (400, 401, 403, etc.) are raised immediately — no fallback.
- If no `fallback_model` is set, the existing retry-only behaviour is unchanged.

---

## Agent files

Each agent is a `.md` file in `{OPENAGENTD_CONFIG_DIR}/agents/`. The team is discovered by scanning all `.md` files in that directory — exactly one must have `role: lead`.

**Member changes are breaking:** removing or renaming a member `.md` file orphans their sessions. Adding a new file is safe.

### Editing agents and skills

Two equivalent workflows:

- **Settings UI** (web) — open `http://localhost:4082/settings/agents` (or `/settings/skills`). Master-detail layout: a searchable sidebar lists every agent/skill, the right pane shows the editor. The hybrid agent editor groups fields into Card sections (Identity, Model & behaviour, Capabilities, System prompt) with a model picker, tool/MCP-server/skill multi-select comboboxes (the Tools picker hides `mcp_*` entries because MCP access is granted server-by-server via the dedicated picker), and inline zod validation; toggle to a raw `.md` view from the editor header for fields the form doesn't model. Saving a valid file is active on the agent's next turn — no team reload, no in-flight turn disruption. Invalid input is rejected client-side (zod) *and* server-side (Pydantic `AgentConfig` + team-level checks). See the [API reference](api/index.md#agent-file-management) for endpoint details.
- **Direct edit on disk** — modify `{OPENAGENTD_CONFIG_DIR}/agents/*.md` in any editor; the change is picked up on the agent's next turn via mtime drift detection. No watcher, no restart needed. Adding or removing agent files (team-shape change) still requires a restart.

### Global summarization & title-generation config

- Summarization defaults live in `.openagentd/config/summarization.md` — see [`agent/summarization.md`](agent/summarization.md) for the three-tier fallback chain (per-agent → file → module defaults).
- Title-generation defaults live in `.openagentd/config/title_generation.md` — see [`title-generation.md`](title-generation.md).

```markdown
---
name: orchestrator
role: lead                    # exactly one agent must be lead; all others are members
description: Coordinates the team. Breaks tasks, delegates, synthesises results.
model: zai:glm-5v-turbo       # multimodal model recommended — lead handles user input
temperature: 0.2
thinking_level: low
tools:
  - date
  - read
  - ls
# fallback_model: copilot:gpt-5-mini
# Per-agent summarization overrides (all fields optional; unset fields fall back to
# .openagentd/config/summarization.md, then to module-level defaults in
# app/agent/hooks/summarization.py):
# summarization:
#   enabled: true
#   token_threshold: 80000
#   keep_last_assistants: 2
#   max_token_length: 5000
#   model: googlegenai:gemini-flash-lite
---

You are the team orchestrator. Coordinate — do not do the work yourself.
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Agent name — defaults to filename stem |
| `role` | No | `lead` or `member` (default `member`) — exactly one file must be `lead` |
| `description` | No | Short intro injected into teammates' system prompts |
| `model` | Yes | `provider:model` string (e.g. `googlegenai:gemini-3.1-flash`) |
| `temperature` | No | Sampling temperature |
| `thinking_level` | No | `low`, `medium`, `high` |
| `tools` | No | List of tool names (see Built-in tools below) |
| `mcp` | No | List of MCP server names (from `mcp.json`); the agent gets every tool that server exposes. See [`agent/tools.md`](agent/tools.md#mcp-servers-appagentmcp). |
| `skills` | No | List of skill names to advertise in system prompt |
| `fallback_model` | No | `provider:model` used on retryable failures |
| `responses_api` | No | `true` to force OpenAI Responses API |
| `summarization` | No | Per-agent summarization overrides (see Summarization) |

The `team_message` tool is injected automatically into all agents — do not list it manually.

### Validation

| Rule | Error |
|------|-------|
| No agent with `role: lead` | `No agent with 'role: lead' found` |
| More than one `role: lead` | `Multiple agents with 'role: lead' found` |
| `model` present but no `:` separator | `invalid model '…' (expected 'provider:model')` |
| Tool name not in built-in registry | `unknown tool '…'` |
| Malformed or missing frontmatter | `missing YAML frontmatter` |

---

## Built-in tools

All tools below are available. List only the ones you want the agent to use under
`tools:` in the agent's `.md` frontmatter.

| Tool name | What it does |
|-----------|-------------|
| `web_search` | DuckDuckGo search |
| `web_fetch` | Fetch a URL and return its content as Markdown |
| `date` | Return today's date/time |
| `read` | Read a file (up to 5 MB; supports offset/limit pagination) |
| `write` | Write or overwrite a file |
| `edit` | Replace exact text in a file (fuzzy-matches whitespace/indentation) |
| `ls` | List directory contents |
| `grep` | Regex content search across files |
| `glob` | Glob pattern search — `match='path'` (default) for full-path patterns like `src/**/*.ts`; `match='name'` for filename-only like `*.py` |
| `rm` | Delete a file or directory (`recursive=true` for non-empty dirs) |
| `shell` | Run a shell command inside the sandbox (supports `background=true` for long-running processes) |
| `bg` | Manage background processes: list, check status, read output, stop |
| `wiki_search` | Search the wiki knowledge base by keyword (BM25) — see [`agent/memory.md`](agent/memory.md) |
| `note` | Append a note to the current session's wiki note file |
| `skill` | Load a skill's instructions (always available — do not list) |

`skill` is **always injected** into every agent — do not list it.

`todo_manage`, `schedule_task`, and `note` are **always injected into the lead agent** — do not list them either.

All filesystem tools (`read`, `write`, `edit`, `ls`, `grep`, `glob`, `rm`) output
paths **relative to the sandbox workspace root**. Absolute paths are never shown to the model.

---

## Skills

Skills are domain-specific instruction sets in `{OPENAGENTD_CONFIG_DIR}/skills/`.
The agent loads them on demand via `skill` before tackling a matching task.

### File format

Each skill lives in its own subdirectory as `{OPENAGENTD_CONFIG_DIR}/skills/{skill-name}/SKILL.md`:

```
{OPENAGENTD_CONFIG_DIR}/skills/
└── my-skill/
    └── SKILL.md          ← required — frontmatter + body
    └── creating.md       ← optional supporting files the agent can read
    └── reference/        ← optional subdirectory with extra reference material
```

`SKILL.md` follows this layout:

```markdown
---
name: my-skill
description: >-
  One-sentence description shown in the system prompt.
---

# My Skill

The full instructions the agent reads when it calls skill("my-skill").
```

The frontmatter (`---` block) is **not** returned to the agent — only the body
below it is. The skill is identified by the `name` field in frontmatter; if
`name` is absent, the subdirectory name is used as a fallback.

### Registering a skill

Add its name to `skills:` in the agent's `.md` frontmatter:

```yaml
skills:
  - my-skill
```

At startup the loader reads every listed skill's `name` and `description`
from frontmatter and appends them to the system prompt as:

```
## Available skills

- **my-skill**: One-sentence description.

Call `skill` with the skill name to load its full instructions.
```

### Current skills

| Name | Purpose |
|------|---------|
| `web-research` | Structured web research methodology |
| `lightpanda` | Web browsing and content extraction via Lightpanda CLI |
| `officecli-docx` | Create, read, and edit Word (.docx) documents |
| `officecli-pptx` | Create, read, and edit PowerPoint (.pptx) presentations |
| `officecli-xlsx` | Create, read, and edit Excel (.xlsx) spreadsheets |
| `officecli-academic-paper` | Formally structured academic papers with TOC, equations, footnotes |
| `officecli-data-dashboard` | Excel dashboards from CSV/tabular data with charts and KPIs |
| `officecli-financial-model` | Multi-sheet financial models (3-statement, DCF, cap table) |
| `officecli-pitch-deck` | Investor and sales pitch decks |
| `morph-ppt` | PowerPoint presentations with smooth Morph animations |
| `skill-installer` | Install new skills from a URL or from scratch |
| `self-healing` | Update the agent's own config on request — model, tools, skills, multimodal (`generate_image`) settings |

---

## Sandbox

Runtime files are split across five XDG-aligned roots. Dev-mode paths shown
below; production maps to `~/.local/share/openagentd[-wiki|-workspace]/`,
`~/.config/openagentd/`, `~/.local/state/openagentd/`, `~/.cache/openagentd/`:

```
.openagentd/
├── data/                                      # OPENAGENTD_DATA_DIR (denied)
│   └── openagentd.db                              # main SQLite DB
├── wiki/                                      # OPENAGENTD_WIKI_DIR (allowed)
│   ├── USER.md                                # always injected into system prompt
│   ├── INDEX.md                               # dream-maintained TOC
│   ├── topics/                                # durable knowledge base
│   └── notes/                                 # session dumps + agent notes
├── workspace/                                 # OPENAGENTD_WORKSPACE_DIR (allowed)
│   └── {lead_session_id}/                     # per-team agent workspace (shared by members)
│       └── uploads/<uuid>.<ext>               # user-uploaded attachments (reachable as `uploads/<filename>`)
├── config/                                    # OPENAGENTD_CONFIG_DIR (allowed)
│   ├── .env                                   # secrets (gitignored)
│   ├── agents/*.md                            # per-agent config
│   ├── dream.md                               # dream agent config
│   ├── skills/{name}/SKILL.md                 # skills
│   ├── summarization.md                       # global summarizer config
│   └── title_generation.md                    # global title-gen config
├── state/                                     # OPENAGENTD_STATE_DIR (denied)
│   ├── logs/
│   │   ├── app/app.log                        # JSON app log, rotated 10 MB / 7 days
│   │   └── sessions/{session_id}/
│   │       ├── session.log                    # human-readable per-session sink
│   │       └── {agent}.jsonl                  # structured event log (SessionLogHook)
│   ├── telemetry/{session_id}/{user_msg_id}.jsonl  # context window snapshots
│   ├── otel/                                  # OTEL spans + metrics (JSONL partitions)
│   └── openagentd.pid                             # server PID file
└── cache/                                     # OPENAGENTD_CACHE_DIR (denied)
    ├── quoteoftheday.json                     # Quote of the Day cache
    ├── copilot_oauth.json                     # GitHub Copilot token
    └── codex_oauth.json                       # OpenAI Codex OAuth token
```

Override any root independently via the matching env var
(`OPENAGENTD_DATA_DIR` / `OPENAGENTD_CONFIG_DIR` / `OPENAGENTD_STATE_DIR` /
`OPENAGENTD_CACHE_DIR` / `OPENAGENTD_WORKSPACE_DIR` / `OPENAGENTD_WIKI_DIR`). Session
IDs are appended automatically by `app/core/paths.py`.

### Session path helpers (`app/core/paths.py`)

Backend code never constructs these paths inline. Two pure helpers return the
canonical `Path` objects:

| Helper | Path | Ownership |
|--------|------|-----------|
| `workspace_dir(sid)` | `{OPENAGENTD_WORKSPACE_DIR}/{sid}` | Agent workspace — the root for filesystem tools (`read`/`ls`/`glob`/`write`/`shell`). File bytes served at `GET /api/team/{sid}/media/{path}`; flat recursive listing at `GET /api/team/{sid}/files` (powers the web UI Files drawer). |
| `uploads_dir(sid)` | `{workspace_dir(sid)}/uploads` | User uploads (flat, UUID names). Served at `GET /api/team/{sid}/uploads/{filename}`. Lives **inside** the session workspace so the agent's filesystem tools can pass user-uploaded images to workspace-bound tools (image/video generation, etc.) as the relative path `uploads/<filename>`. |

User-uploaded files reach the LLM through the curated multimodal rehydration
pipeline in `app/agent/multimodal.py`. They are *also* reachable by the
agent's filesystem tools — this is intentional, so user-uploaded images can be
fed into workspace-bound tools without a staging step.
`DELETE /api/team/sessions/{id}` purges the whole workspace, uploads
included.

### Sandbox model and permissions

The sandbox uses a **denylist** path-validation model and a separate
**permission system** that gates every tool call. Both are documented in
[`agent/tools.md`](agent/tools.md#filesystem-builtinfilesystem) — see
that page for the full denylist rules, symlink/tilde handling, the
shell-command path-token scan (best-effort), and the
`AutoAllowPermissionService` / `Ruleset` flow.

User-defined deny patterns (glob strings like `**/.env`, `**/secrets/**`)
are persisted in `{OPENAGENTD_CONFIG_DIR}/sandbox.yaml` and editable via
`/settings/sandbox` in the UI (or directly via
[`PUT /api/settings/sandbox`](api/index.md#settings)). Patterns are
loaded each time a `SandboxConfig` is built, so changes take effect on
the next agent run without a server restart. `**/.env` and `**/.env.*`
are the seeded defaults — they come from `SandboxFileConfig`'s model
default, so they apply both when the file is absent *and* when the file
exists but omits the `denied_patterns` key. The file is only written
when the user saves from the UI.

To relocate any root, set the matching env var listed in the
[Environment variables](#environment-variables) table — e.g.
`OPENAGENTD_WORKSPACE_DIR=/srv/openagentd-workspace`.

---

## Hooks

Hooks let you intercept the agent loop at key points without modifying core
logic. See [`documents/docs/agent/hooks.md`](agent/hooks.md)
for the full API.

Built-in hooks (all active by default in `TeamMemberBase._handle_messages()`):

| Hook | Purpose |
|------|---------|
| `StreamPublisherHook` | Publishes SSE events for the response stream |
| `SummarizationHook` | Rolling-window summarization when context grows large (pure state transform — no DB access) |
| `DynamicPromptHook` | Injects current date into system prompt |
| `AgentTeamProtocolHook` | Team-only — injects communication protocol, workflow, and roster into system prompt |
| `SessionLogHook` | Writes verbose JSONL per session to `{OPENAGENTD_STATE_DIR}/logs/sessions/` |

DB persistence is handled by `SQLiteCheckpointer` (passed to `agent.run()`), not by a hook.
See [`documents/architecture.md`](architecture.md) for the Checkpointer protocol details.

### SummarizationHook behaviour

- Fires in `before_model` when `state.usage.last_prompt_tokens` meets or exceeds the resolved `token_threshold` (per-agent → file config → `DEFAULT_PROMPT_TOKEN_THRESHOLD`). The loop sets `last_prompt_tokens` after each model call — no DB read required.
- **Pure state transform**: reads token count from `AgentState`, mutates `state.messages` directly. No database factory or session needed.
- Stateless across HTTP requests — each request constructs a fresh hook instance.
- Saves the summary as `role=assistant, is_summary=True`. Previous summaries are hidden (`exclude_from_context=True`) when a new one is created.
- All summarised messages (user, assistant, tool) are marked `exclude_from_context=True`; the last `keep_last_assistants` assistant turns (and their surrounding context) are kept verbatim.
- **Session resume**: `SQLiteCheckpointer.mark_loaded()` extracts `extra.usage.input` from the last assistant message in history and stores it. The agent loop calls `checkpointer.seed_state(session_id, state)` right after building `AgentState`, seeding `last_prompt_tokens` automatically. Works for both single-agent (`POST /api/chat`) and team member paths — no per-call-site workaround needed.
- **UI**: `GET /api/chat/sessions/{id}` filters out `is_summary=True` rows — users see the full unabridged conversation without internal summaries. `get_messages_for_llm` returns `[latest_summary] + [non-excluded, non-summary messages]` — summary is always first in LLM context.
- See [`documents/docs/agent/summarization.md`](agent/summarization.md) for full design details.

---

## Running

```bash
uv sync                  # install dependencies

openagentd                   # start server + web UI (production, background)
openagentd --dev             # start with hot-reload (foreground); watches app/ only
                         #   config edits (agents/, skills/, mcp.json) need a manual restart
openagentd stop              # stop background processes
openagentd status            # check if running
openagentd logs              # tail the server log
openagentd doctor            # check system health
openagentd update            # update to the latest version
```

Database migrations run automatically on startup in production mode.

The API is available at `http://localhost:4082/api`.
Interactive docs: `http://localhost:4082/docs`.
Web UI: `http://localhost:4082` (production) or `http://localhost:5173` (development with `--dev`).

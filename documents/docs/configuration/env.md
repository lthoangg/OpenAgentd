---
title: Environment Variables
description: Every env var read by OpenAgentd — provider keys, ports, paths, optional extras.
status: stable
updated: 2026-07-14
---

# Environment Variables

**Source:** `app/core/config.py` (Pydantic `Settings`)

All settings live in `app/core/config.py`. Copy `.env.example` to the right `.env` location ([`paths.md`](./paths.md)) and fill in the keys you need.

`APP_ENV` now defaults to `development` when you run from a source checkout. Installed / CLI-managed server entry points still run in `production` because `openagentd start` / `openagentd serve` inject `APP_ENV=production`, and `openagentd init` writes `APP_ENV=production` into the generated user `.env`.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `development` | `production` or `development` — controls data directory, log level, and config YAML defaults. Source-checkout runs default to `development`; CLI-launched servers force `production`. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`. |
| `API_HOST` | `127.0.0.1` | Bind address. Non-loopback values require a configured access key in OpenAgentd-managed launchers. |
| `API_PORT` | `4082` | Bind port. `make dev` overrides via uvicorn flags to use `:8000`. |
| `API_RELOAD` | `False` | Enables uvicorn auto-reload when set true. |
| `API_ALLOW_INSECURE_LAN` | `False` | Explicitly permits an unauthenticated non-loopback bind. `make dev-lan` sets this for trusted-network development; do not use it in production. |
| `CORS_ORIGINS` | `["*"]` | Allowed CORS origins. |
| `DATABASE_URL` | `{OPENAGENTD_DATA_DIR}/openagentd.db` | SQLite path or async DB URL. |

## Paths

See [`paths.md`](./paths.md) for what lives under each root and the production / development defaults.

| Variable | Description |
|----------|-------------|
| `OPENAGENTD_DATA_DIR` | Root for irreplaceable user data (DB). Denied to agent fs tools. |
| `OPENAGENTD_CONFIG_DIR` | Root for hand-edited config (agents, skills, prompts, `.env`). |
| `OPENAGENTD_STATE_DIR` | Root for logs, telemetry, OTEL rollups, PID file. |
| `OPENAGENTD_CACHE_DIR` | Root for regeneratable throwaway data. |
| `OPENAGENTD_WORKSPACE_DIR` | Per-session agent workspaces (`{root}/<sid>/`). Allowed by the sandbox. |
| `OPENAGENTD_DISABLE_LSP_DOWNLOAD` | Set to `true` to disable consented, on-demand managed LSP component downloads. |
| `AGENTS_DIR` | Defaults to `{OPENAGENTD_CONFIG_DIR}/agents`. |
| `SKILLS_DIR` | Defaults to `{OPENAGENTD_CONFIG_DIR}/skills`. |
| `OPENAGENTD_PLUGINS_DIRS` | List of plugin directories separated by the OS path separator (`:` on macOS/Linux, `;` on Windows — same convention as `PATH`/`PYTHONPATH`). Defaults to `{OPENAGENTD_CONFIG_DIR}/plugins`. See [`agent/plugins.md`](../agent/plugins.md). |
| `MULTIMODAL_CONFIG_PATH` | Defaults to `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml`. Drives `generate_image` / `generate_video`. |

## LLM provider keys

Each entry is required only for the providers you actually use. See [`providers.md`](./providers.md) for the full provider catalog.

| Variable | Provider |
|----------|----------|
| `GOOGLE_API_KEY` | `googlegenai` (Google Gemini Developer API) |
| `VERTEXAI_API_KEY` | `vertexai` (Vertex AI; optional — falls back to ADC) |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI project ID |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI region (default `global`) |
| `ZAI_API_KEY` | `zai` |
| `OPENAI_API_KEY` | `openai` |
| `OPENROUTER_API_KEY` | `openrouter` |
| `NVIDIA_API_KEY` | `nvidia` (NVIDIA NIM) |
| `XAI_API_KEY` | `xai` (xAI Grok) |
| `DEEPSEEK_API_KEY` | `deepseek` |
| `AWS_BEDROCK_REGION` | `bedrock`. Falls back to `AWS_DEFAULT_REGION`, then `us-east-1`. |
| `AWS_BEDROCK_PROFILE` | Named AWS profile (`~/.aws/credentials`). Unset = default boto3 chain (env vars / instance role / etc.). |
| `ROUTER9_API_KEY` | `router9` ([9Router](https://github.com/decolua/9router) local proxy). |
| `ROUTER9_BASE_URL` | OpenAI-compatible base URL (default `http://localhost:20128/v1`). |
| `CLIPROXY_API_KEY` | `cliproxy` ([CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) local proxy). |
| `CLIPROXY_BASE_URL` | OpenAI-compatible base URL (default `http://localhost:8317/v1`). |
| `OLLAMA_API_KEY` | Optional for the local `ollama` daemon, which ignores auth. |
| `OLLAMA_BASE_URL` | OpenAI-compatible base URL (default `http://localhost:11434/v1`). |
| `NINJA_API_KEY` | Quote of the Day via [API Ninjas](https://api-ninjas.com) (free tier: 3 000 calls/month). |

OAuth-based providers don't need an env var — run the matching `openagentd auth` command instead:

| Provider | Command |
|----------|---------|
| GitHub Copilot | `openagentd auth copilot` |
| OpenAI Codex (ChatGPT) | `openagentd auth codex` (or `--device` for SSH) |

Tokens are cached at `{OPENAGENTD_CACHE_DIR}/copilot_oauth.json` and `{OPENAGENTD_CACHE_DIR}/codex_oauth.json` and refreshed automatically.

## Service-level defaults (not env vars)

Summarization thresholds, tool-result offload sizes, and sandbox limits are module-level constants in their respective service modules — **not** environment variables. Runtime settings such as title generation and LSP server overrides live in `{OPENAGENTD_CONFIG_DIR}/settings.yaml`; per-agent behavior stays in agent frontmatter.

- `{OPENAGENTD_CONFIG_DIR}/settings.yaml` — see [`title-generation.md`](../title-generation.md) for title generation and [`lsp.md`](./lsp.md) for the `lsp:` server map.
- `{OPENAGENTD_CONFIG_DIR}/server.yaml` — CLI server bind host, port, and access key; separate from the desktop builtin sidecar's launch token.
- Per-agent `.md` frontmatter — see [`agents.md`](./agents.md).

## Optional extras

Most features ship by default — document conversion for PDF, DOCX, and HTML (`markitdown[pdf,docx]` plus markitdown core), client-side voice input where the browser/WebView supports speech recognition, and everything else needed to make the desktop app "just work" out of the box.

A few heavier features remain opt-in:

| Extra | Enables | Install |
|-------|---------|---------|
| `audio` | File-attached audio transcription via markitdown's audio backend (`speech_recognition` + `pydub`). Distinct from live microphone input, which uses client-side speech recognition. | `uv sync --extra audio` |
| `azure-doc-intel` | Azure Document Intelligence server-side OCR fallback inside markitdown. | `uv sync --extra azure-doc-intel` |
| `full` | All optional extras (`audio,azure-doc-intel`). | `uv sync --extra full` |

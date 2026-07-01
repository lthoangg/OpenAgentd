---
title: LLM Providers
description: Every provider registered in build_provider — keys, model IDs, vision defaults, OAuth flows.
status: stable
updated: 2026-06-26
---

# LLM Providers

**Sources:** `app/agent/providers/factory.py`, `app/agent/providers/catalog.py`, `app/agent/providers/plugin_registry.py`, `app/api/routes/settings.py`, `app/agent/providers/model_registry.json`, `app/agent/providers/model_registry.py`, `app/agent/providers/capabilities.py`, `app/agent/providers/model_metadata.py`

A model is selected by setting `model: <prefix>:<model-id>` in an agent's `.md` frontmatter. The prefix selects the provider; the rest is passed verbatim to that provider's API.

## Setup paths

- **Desktop/web UI:** open **Settings → Providers**. First launch creates the config/cache/state/data/workspace roots, `{OPENAGENTD_CONFIG_DIR}/plugins`, and default editable agents with a placeholder model. Packaged installs download those defaults from the GitHub release seed bundle. API-key providers write to `{OPENAGENTD_CONFIG_DIR}/.env`; OAuth providers use the in-app flow and store tokens under `{OPENAGENTD_CACHE_DIR}`.
- **CLI/server:** run `openagentd init` for first setup, or `openagentd auth copilot|codex` for OAuth-only providers.

Provider setup replaces the seeded placeholder model without overwriting existing user-edited files.

Provider construction is lazy-tolerant: a missing key or unavailable local daemon does not prevent the app from starting. Agent load logs the unavailable provider and substitutes an unconfigured provider stub. The first attempted turn then surfaces an actionable provider-setup error in the UI instead of crashing startup.

## Registered prefixes

Built-ins are resolved in `app/agent/providers/factory.py`; provider plugins are resolved from `{OPENAGENTD_CONFIG_DIR}/plugins/` after built-ins.

| Prefix | Auth | Notes |
|--------|------|-------|
| `anthropic` | `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_BASE_URL`) | Built-in Anthropic Messages API support. |
| `googlegenai` | `GOOGLE_API_KEY` | Google Gemini Developer API. |
| `vertexai` | `VERTEXAI_API_KEY` *or* ADC + `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI (express or normal mode). |
| `zai` | `ZAI_API_KEY` | ZAI / GLM; chat completions only. |
| `openai` | `OPENAI_API_KEY` | Chat Completions by default; `thinking_level` auto-routes to the Responses API. |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter — any catalog model; chat completions only. |
| `nvidia` | `NVIDIA_API_KEY` | [NVIDIA NIM](https://build.nvidia.com/models); chat completions only. |
| `xai` | `XAI_API_KEY` | xAI Grok; chat completions only. |
| `deepseek` | `DEEPSEEK_API_KEY` | DeepSeek (OpenAI-compatible); chat completions only. |
| `bedrock` | AWS creds (env / profile / instance) | Converse API across all Bedrock model families. |
| `copilot` | `openagentd auth copilot` | GitHub Copilot OAuth (device flow). |
| `codex` | `openagentd auth codex` | OpenAI Codex via ChatGPT subscription. The UI tries device-code auth first, then falls back to browser PKCE when a workspace disables device-code auth. CLI uses browser PKCE by default; `--device` is available for headless setup. |
| `router9` | `ROUTER9_API_KEY` (+ optional `ROUTER9_BASE_URL`) | Local [9Router](https://github.com/decolua/9router) proxy; chat completions only. |
| `cliproxy` | `CLIPROXY_API_KEY` (+ optional `CLIPROXY_BASE_URL`) | Local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) proxy; chat completions only. |
| `ollama` | `OLLAMA_API_KEY` (optional; daemon ignores auth) | Local [Ollama](https://docs.ollama.com/api/openai) at `http://localhost:11434/v1`; chat completions only. |

The model id after the prefix is passed **verbatim** to the upstream. The Settings model picker filters provider listings to agent-usable text-chat models, so generation-only models such as `veo-*`, `imagen-*`, image-preview, embeddings, and TTS models are hidden.

## Visible models

Each provider card in **Settings → Providers** can save a provider-local `visible_models` list in `{OPENAGENTD_CONFIG_DIR}/settings.yaml`:

```yaml
providers:
  openai:
    visible_models:
      - gpt-5.1
      - gpt-5.1-mini
```

This is a UI visibility filter, not runtime enforcement. Use the per-model visibility button in the provider card to choose which models appear in normal model pickers. Missing or empty `visible_models` means all cached agent-usable models for that provider remain visible.

Provider model lists are now **cache-first**:

- **Session settings / normal model pickers** read only the cached provider-local `cached_models` list from `settings.yaml`, so opening a picker never waits on provider network calls.
- There is no provider-side fallback model catalog anymore. If a provider has no cached discovered models yet, its picker entries can be empty until the user lists models successfully.
- Clicking **List models** performs an immediate live refresh for that provider; using candidate unsaved credentials verifies the candidate key but does **not** persist that model list until the provider is saved / refreshed with saved credentials.
- When `/api/agents/registry` is asked for picker models and a configured provider has no cached discovered models yet, the backend warms that provider cache on demand before returning the registry.
- Saving or reconnecting a provider invalidates the cached picker registry so subsequent picker opens see the refreshed cached list.

## Provider plugins

Drop-in provider plugins live in `{OPENAGENTD_CONFIG_DIR}/plugins/` and export a `ProviderPlugin` named `provider`. They can:

- appear in **Settings → Providers** with declared credential fields;
- save credentials to `{OPENAGENTD_CONFIG_DIR}/.env`;
- store provider-owned OAuth tokens under `{OPENAGENTD_CACHE_DIR}/provider-plugins/<provider-id>/`;
- provide model discovery and a factory returning `LLMProviderBase`;
- declare `models.dev` metadata aliases with `models_dev_provider_id`, `metadata_source_provider`, or exact `model_registry_aliases` when runtime IDs differ from upstream IDs;
- surface live OAuth usage in **Settings → Providers** via an optional usage hook;
- opt out of mid-stream interrupt by setting `support_interrupt = False` on the provider class (see below).

The same directory can also contain agent hook plugins. Files that export
`provider = ProviderPlugin(...)` are handled by the provider registry and are
skipped by the agent hook loader.

OAuth plugins can emit a `code_required` event; the UI then shows a paste field and posts the code to `/api/auth/{provider}/callback`.

**Non-interruptible providers.** Providers that route through stateful or quota-tracked streaming connections (e.g. proxy-based providers) should set `support_interrupt = False` on their `LLMProviderBase` subclass. This prevents the agent loop from cutting the in-flight stream short when the user presses Stop — the current LLM call completes in full, and only the next between-iteration check observes the interrupt. Tools and the between-iteration guard are still cancelled normally. The default is `True`.

```python
class MyProxyProvider(LLMProviderBase):
    support_interrupt = False  # stream always completes before interrupt is observed
```

OAuth plugins without a usage hook are shown as connected but unsupported for
usage monitoring, rather than as temporarily unavailable.

If an OAuth refresh token is rejected by the upstream provider, the provider should raise `ProviderAuthenticationError`. Team execution maps that to the same actionable `agent_not_configured` stream event as an unconfigured model, so the UI can ask the user to reconnect the provider instead of surfacing an internal stack trace. The retry layer also auto-classifies raw `401`/`403` HTTP responses from any provider into `ProviderAuthenticationError`, and `400`/`404`/`422` into `ProviderRequestError` (carrying the provider's own error message), so misconfigured keys or bad model names produce a clear, actionable error rather than a generic status code. See [agent/loop.md](../agent/loop.md#retry--fallback).

## Capability detection

Each model's input/output capabilities (vision, document text, audio, video, etc.) are resolved by `get_capabilities(model_id)` in `capabilities.py` from the model registry:

1. Bundled `app/agent/providers/model_registry.json` snapshot → cold/offline baseline.
2. Cached/refreshed `https://models.dev/api.json` → normal runtime metadata source.
3. Optional `{OPENAGENTD_CONFIG_DIR}/model_registry.yaml` → local override for private or newly released models.
4. Anything still unknown → text input/output defaults.

There are no prefix fallbacks and no name-substring heuristics. Model IDs are exact `provider:model` keys after provider alias normalization. Runtime provider/model IDs that differ from `models.dev` source IDs are handled through provider-owned compatibility aliases, not inferred from prefixes or substrings.

Release maintainers refresh the bundled JSON before shipping with:

```bash
uv run python scripts/update_model_registry.py
```

Set `OPENAGENTD_MODEL_REGISTRY_REFRESH=false` to disable runtime fetches and use only the bundled JSON plus local YAML overlay.

## Model metadata

Model metadata lives beside modality flags and is resolved through `model_metadata.py`. It currently tracks token limits, cost, support flags (`tool_call`, `attachment`, `temperature`, `reasoning`), status/release date, and advertised `thinking_level` values:

```yaml
"openai:gpt-5":
  capabilities:
    input: { vision: true }
  limits: { context_length: 272000, max_completion_tokens: 128000 }
  thinking: { levels: [minimal, low, medium, high] }
```

`thinking.levels` is descriptive metadata for callers such as settings UIs or validation layers. Runtime provider behavior still treats `thinking_level: none`/`off` as disable/default even when `none` is not listed for a model.

## Provider notes

### `googlegenai` / `vertexai`

Standard Gemini APIs. `_sanitize_schema()` strips JSON-Schema fields Gemini doesn't accept (`discriminator`, `const`, `exclusiveMinimum`, `additionalProperties`). New unsupported fields can be added to `_UNSUPPORTED_SCHEMA_KEYS` in `googlegenai.py` — see [`troubleshooting.md`](../troubleshooting.md).

### `openai`

Chat Completions by default. Setting any non-`none` `thinking_level` automatically routes through the **Responses API** (`/v1/responses`) because Chat Completions doesn't accept `reasoning_effort` alongside function tools. Override via `model_kwargs.responses_api: true/false`.

When routed to `/v1/responses`, `temperature` and `top_p` are silently ignored (the API doesn't accept them); `max_tokens` maps to `max_output_tokens`.

On Chat Completions, callers still use the provider-agnostic `max_tokens` setting. The OpenAI-compatible handler serializes it to the upstream field name: OpenAI/Copilot/xAI use `max_completion_tokens`; DeepSeek keeps legacy `max_tokens`.

Other OpenAI-compatible providers (`openrouter`, `nvidia`, `cliproxy`, `router9`, `ollama`, `xai`, and `deepseek`) are pinned to `/v1/chat/completions`. They do not auto-route to `/v1/responses` when `thinking_level` is set, because those upstreams expose OpenAI-compatible chat completions but not OpenAI's Responses API.

### `anthropic`

Uses Anthropic's Messages API at `https://api.anthropic.com/v1/messages`. API-key support is built in and configured with `ANTHROPIC_API_KEY`; set `ANTHROPIC_BASE_URL` only for compatible gateways.

`thinking_level` maps to Anthropic manual thinking (`thinking: {type: "enabled", budget_tokens: ...}`) on supported Claude models; OpenAgentd does not use Anthropic adaptive thinking. When model metadata only exposes `budget_tokens` support (without named effort levels), OpenAgentd synthesizes the standard UI levels `none` / `low` / `medium` / `high` and maps them to budgets from `max_tokens` at runtime: `none` omits the `thinking` block, `low` uses `max(1024, min(25% of max_tokens, max_tokens - 1))`, `medium` uses `max(1024, min(40% of max_tokens, max_tokens - 1))`, and `high` uses `max(1024, min(60% of max_tokens, max_tokens - 1))`. For example, with `max_tokens=4096`, the generated budgets are `low=1024`, `medium=1638`, and `high=2457`. Sampling fields are omitted for newer Claude 4.5+ families that reject legacy sampling parameters.

Prompt caching now follows Anthropic's explicit breakpoint pattern instead of marking every block cacheable: OpenAgentd marks the system block and the latest user/tool-result block with `cache_control: {"type": "ephemeral"}` so repeated turns can reuse the stable prefix without exhausting Anthropic's breakpoint budget. Anthropic usage accounting also treats `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` as total prompt input while still surfacing cached reads separately.

### `codex`

Uses your **ChatGPT Plus/Pro/Business subscription** to access OpenAI models via `https://chatgpt.com/backend-api/codex/responses`. The endpoint is Responses API only and requires streaming; non-streaming `chat()` calls are assembled from the stream. `temperature`, `top_p`, and `max_tokens` are ignored because the private endpoint rejects those public API fields. `thinking_level` maps to `reasoning.effort`. Session settings show a Codex Fast mode toggle when the effective lead model is `codex:*`; OpenAgentd sends that upstream as priority service tier for new requests while unsupported providers ignore `fast_mode`. OpenAI currently documents Fast mode for GPT-5.5 and GPT-5.4, with higher credit consumption than Standard mode. OpenAgentd identifies itself with `originator: openagentd`, retries transient `response.failed` stream errors such as overloads, and treats Codex usage-limit/quota responses as immediate fallback candidates. Settings → Providers shows live Codex OAuth usage windows, resets, credits, spend-cap/limit states, and unlimited-credit plans from the same token. The same OAuth token also powers `generate_image` when `multimodal.yaml` sets `image.model: codex:<chat-model>`.

### `copilot`

GitHub Copilot OAuth — requires an active Copilot subscription. Models include `copilot:gpt-…`, `copilot:claude-…`, etc. (see Copilot's catalog). OpenAgentd now follows Copilot's live `/models` metadata for endpoint selection when credentials are available, falling back to a built-in map offline. OAuth tokens may also target GitHub Enterprise Copilot by passing an enterprise URL during login; the saved token then uses `https://copilot-api.<your-domain>` for model discovery and chat traffic. Settings → Providers shows the live Copilot premium request quota from the same token.

### `bedrock`

Uses the **Converse API** (`boto3 bedrock-runtime`). Auth resolves in priority order:

1. Explicit `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`.
2. Named profile via `AWS_BEDROCK_PROFILE`.
3. Standard boto3 credential chain (instance profile, IAM role, etc.).

Region: `AWS_BEDROCK_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

Prefer `global.*` model IDs for higher availability. The provider uses `asyncio.to_thread` to wrap boto3's synchronous calls — `aiobotocore` is not used because it lacks Bedrock's `converse_stream` event-stream format.

Smoke tests (no server required):

```bash
uv run python -m manual.try_providers.try_bedrock --simple
uv run python -m manual.try_providers.try_bedrock --tools
```

### `router9` / `cliproxy`

Both talk to a **locally-running OpenAI-compatible proxy** that fans out to many upstream models. Set the API key (and optionally override the default port via `*_BASE_URL`).

| Provider | Upstream | Default base URL |
|----------|----------|------------------|
| `router9` | 9Router — Node.js dashboard, 40+ providers, quota tracking | `http://localhost:20128/v1` |
| `cliproxy` | CLIProxyAPI — Go proxy wrapping Gemini CLI / ChatGPT Codex / Claude Code OAuth | `http://localhost:8317/v1` |

The model id after the prefix is passed verbatim to the proxy — see the upstream dashboard / `/v1/models` for the live catalog. Both providers are always routed through `/v1/chat/completions`; session/agent `thinking_level` settings will not switch them to Responses API. If `cliproxy` is run without auth, any non-empty `CLIPROXY_API_KEY` value works (the header is required by the OpenAI client).

### `ollama`

Talks to the local Ollama daemon over its OpenAI-compatible API. The daemon ignores auth, so `OLLAMA_API_KEY` defaults to unset. The provider supplies an internal placeholder only when calling the OpenAI SDK.

```bash
ollama serve                # daemon (usually already running)
ollama pull llama3.2        # pull any model
```

**Cloud models.** Ollama Cloud runs *through* the same local daemon — there is no separate HTTPS endpoint. After running `ollama signin` once, any model name with the `-cloud` suffix is transparently routed to [ollama.com](https://ollama.com/search?c=cloud). Use the exact name `ollama list` shows.

**Remote daemon.** Point at a daemon on another machine via `OLLAMA_BASE_URL`.

**Capability defaults:** By default, vision is `false` in the model registry for the `ollama:` prefix. However, you can freely attach images and documents to any model; if the model supports it, the call will succeed.

## Thinking (`thinking_level`)

Enables extended reasoning on supporting models.

The common baseline values are:

| Value | Behaviour |
|-------|-----------|
| `none` (default) | Thinking disabled. |
| `low` | Lightweight reasoning pass. |
| `medium` | Balanced reasoning. |
| `high` | Maximum reasoning effort. |

**Valid values are model-specific.** Each model advertises its supported levels via `thinking_levels` in the model registry (`GET /api/registry`). Some models expose additional levels beyond the baseline (e.g. `minimal`, `xhigh`, `max`). The settings UI populates the thinking level picker from the selected model's metadata and falls back to the baseline list when the model reports none.

Mapping varies per provider. Some use reasoning effort fields, some use provider-specific thinking objects, and non-reasoning models ignore the field.

## Fast Mode / Service Tiers

Enables priority or fast latency tiers on supported models and providers. Users can opt new messages in a session into Fast Mode, which translates to the corresponding upstream service tier.

| Provider | Upstream parameter | Mapping | Notes |
|---|---|---|---|
| `codex` | `service_tier` | `"fast"` ➔ `"priority"` | Uses ChatGPT-subscription Codex Fast mode. |
| `googlegenai` | `service_tier` | `"fast"` ➔ `"priority"` | Uses Gemini Priority inference tier for business-critical workloads. |
| `vertexai` | `service_tier` | `"fast"` ➔ `"priority"` | Sent in the request body (may be ignored depending on Vertex AI project settings). |
| `openai` | `service_tier` | `"fast"` ➔ `"auto"` | Uses OpenAI's scale/priority automatic routing. Only sent for official `api.openai.com` requests. |
| `anthropic` | `service_tier` | `"fast"` ➔ `"auto"` | Automatically uses Priority Tier when available. Only sent for official `api.anthropic.com` requests. |
| Others (e.g. DeepSeek, xAI, Ollama) | Not supported | Ignored / Omitted | To prevent `400 Bad Request` errors, the setting is omitted from the request body for all other OpenAI-compatible and third-party providers. |

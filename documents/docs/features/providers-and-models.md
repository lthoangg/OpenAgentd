---
title: "Features: Providers and models"
description: "Supported providers, sign-in, model choice, thinking levels, accounts and backup models."
---

# Providers and models

Part of the [feature catalogue](../features.md), under *5. Providers and models*. The index explains the version tags.

Switch providers with one line in your agent config. The product is provider-
agnostic by design.

**19 first-class providers:**

| Provider | Config syntax | Auth |
|---|---|---|
| Anthropic Claude | `anthropic:claude-sonnet-4-6` | `ANTHROPIC_API_KEY` `[v1.14.0]` |
| Google Gemini | `googlegenai:gemini-3.1-flash` | `GOOGLE_API_KEY` |
| Google Vertex AI | `vertexai:gemini-3-flash-preview` | `VERTEXAI_API_KEY` or GCP creds |
| OpenAI | `openai:gpt-5.5` | `OPENAI_API_KEY` |
| OpenCode Zen | `opencode:claude-sonnet-4-6` | `OPENCODE_ZEN_API_KEY` `[v1.124.0]` |
| OpenCode Go | `opencode-go:deepseek-v4-flash` | `OPENCODE_GO_API_KEY` `[v1.124.0]` |
| OpenRouter | `openrouter:qwen/qwen3.6-plus:free` | `OPENROUTER_API_KEY` |
| ZAI / GLM | `zai:glm-5-turbo` | `ZAI_API_KEY` |
| xAI Grok | `xai:grok-4.20` | `XAI_API_KEY` |
| Grok Build | `grok:grok-4.7` | `agentd auth grok` `[v1.112.0]` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-6` | Bedrock Mantle bearer token (`AWS_BEARER_TOKEN_BEDROCK`) or AWS profile/default credential chain `[v1.110.0]` |
| Cloudflare (Workers AI + AI Gateway) | `cf:@cf/deepseek-ai/deepseek-v4.1-flash-1017` · `cf:openai/gpt-4.1` | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Account → Workers AI → Read) `[v3.62.0]` |
| NVIDIA NIM | `nvidia:stepfun-ai/step-3.5-flash` | `NVIDIA_API_KEY` |
| GitHub Copilot (OAuth) | `copilot:gpt-4.1` | `agentd auth copilot` |
| OpenAI Codex (OAuth) | `codex:gpt-5.5` | `agentd auth codex` |
| Router9 (local) | `router9:cc/claude-sonnet-4-5` | `ROUTER9_API_KEY` (optional) |
| CLIProxyAPI (local) | `cliproxy:gemini-2.5-pro` | `CLIPROXY_API_KEY` (optional) |
| Ollama (local + cloud) | `ollama:llama3.2` · `ollama:kimi-k2.6-cloud` | none (cloud: `ollama signin`) |

- **Connect a model from the first screen** `[v3.31.0]` — until a message
  could run (the lead agent has no model yet, or its provider is not
  connected), the new-session screen shows a setup card instead of the
  "Connect a model provider" banner. It has quick picks for Anthropic,
  OpenAI, Gemini, OpenRouter, ChatGPT and GitHub Copilot. Pasting a key and
  choosing **Connect** checks the key and saves it in one step, and
  subscriptions sign in through the usual dialog. A provider that already
  works (a saved key, a key exported in the server's environment, or a running
  Ollama) is offered with a one-click **Use**. **More providers…** opens
  Settings → Models. Open sessions keep the banner, which now follows the
  same rule, so it no longer hides while sends would fail and no longer shows
  for a working Ollama setup. Since `[v3.62.0]`, when the agent's model
  runs on this computer and its app is not running, the card says to start
  it and has **Check again**; before, it only went away after leaving the
  window and coming back.
- **A saved key is enough to chat** `[v3.31.0]` — when the first provider
  gets a credential (Settings → Models, the setup card, or `POST
  /api/settings/providers/{id}/credentials`), agents that have no model yet
  get that provider's suggested model, read from its live model list:
  the newest match of a version pattern such as `claude-sonnet-*`. Without a
  match, the newest tool-calling model is used. Models the user chose are
  never replaced. `POST /api/settings/default-model` also accepts
  `{"provider": "<id>"}` to apply the same choice.
- **Cloudflare Workers AI and AI Gateway** `[v3.62.0]` — the `cf` provider
  sends every model through Cloudflare's REST API
  (`api.cloudflare.com/client/v4/accounts/{account}/ai/v1`, chat
  completions) and routes it through the account's `default` AI Gateway,
  which Cloudflare creates on first use; its logging, caching and rate
  limits apply. Workers AI
  models use `@cf/…` ids; third-party models use `author/model`
  (`openai/gpt-4.1`, `anthropic/claude-sonnet-4.6`) and are billed through
  Cloudflare Unified Billing, so the account needs credits for them. The
  model list has the account's Workers AI text models plus the third-party
  models models.dev lists for AI Gateway. The Settings card asks for two
  values, the Account ID and an API token, and under each says where to get
  it, with a link to the dashboard's Workers AI → Use REST API page. The
  token needs **Account → Workers AI → Read**; one with only AI Gateway
  permissions is refused.
- **Resilient provider construction** `[v1.17.0]` — missing/unavailable
  providers no longer block startup; an unconfigured stub surfaces an
  actionable UI error on first use.
- **Chat-completions-only compatible routing** `[v1.44.3]` — OpenAI-compatible
  providers that do not expose OpenAI's Responses API stay on `/v1/chat/completions`
  even when session or agent thinking settings are enabled.
- **OpenAI uses the Responses API by default** `[v3.37.0]` — the `openai`
  provider sends every request to `/v1/responses`, so newer models that
  reason by default can call tools (they reject tools on
  `/v1/chat/completions` with HTTP 400). Set `responses_api: false` in a
  model's settings to keep chat completions.
- **AWS Bedrock Mantle-only routing** `[v1.110.0]` — Bedrock models use Mantle's
  Anthropic- or OpenAI-compatible route metadata and bearer-token auth; native
  Converse and the access-key/secret-key Settings path were removed. This is an
  explicit user-approved hard conversion, so it did not follow the normal
  feature deprecation period.
- **Pure-Python SigV4 AWS Bedrock token generator** `[v2.0.0]` — replaces `botocore`
  with a pure-Python SigV4 token generator, dropping AWS bundle strip overhead and
  runtime memory footprint.
- **Anthropic-compatible custom endpoints** `[v1.16.0]` — providers needing
  custom headers or alternate message endpoints are supported.
- **Anthropic prompt caching + full input accounting** `[v1.66.0]` — Claude
  requests now place explicit `cache_control: {type: "ephemeral"}` markers on
  the system block and latest cacheable turn block, matching Anthropic's
  breakpoint model instead of marking every block. Stored/model usage now counts
  total prompt input as cold + cache-read + cache-write tokens while preserving
  cached reads as a separate metric. Cache-write tokens are billed at the
  registry's `cache_write` rate — 1.25x input on Claude models — instead of the
   plain input rate `[v1.132.0]`.
- **Claude turns survive a summary** `[v3.57.0]` — newer Claude models
  (Opus 5.5, Fable 5.2, …) only accept a thinking block in the conversation
  that produced it, so the first request after a summary failed with
  "bound to a different conversation". Turns kept after a summary are now
  sent without their old thinking (their text and tool calls stay), and
  requests to Anthropic's API let it drop any other thinking block whose
  conversation changed instead of failing the turn.
- **Adaptive thinking on new Claude models by default** `[v3.62.0]` — Claude
  models now get adaptive thinking (effort levels) unless they predate it
  (Claude 3.x, Sonnet/Opus 4.0, Opus 4.1, and the 4.5 models, which keep token
  budgets). Haiku 5.5 with thinking on no longer fails with HTTP 400, and
  later Claude releases work without an update.
- **Budget-based thinking metadata synthesis** `[v1.83.0]` — models whose
  registry metadata exposes raw `budget_tokens` reasoning support but no named
  effort levels now surface standard `none/low/medium/high` thinking choices in
  Settings, with Anthropic runtime mapping those levels to proportional token
  budgets.
- **`openagentd://` deep links and OAuth callback handoff** `[v1.116.0]` — system protocol registration for desktop and mobile apps, with cold- and warm-start routing. Navigation links (`openagentd://session/<id>`) open the requested session; the `cockpit` and `coding` hosts and the `/coding` paths of builds before v3.0.0 are no longer read `[v3.54.0]`. OAuth providers that implement a callback exchange can use `openagentd://auth/callback?provider=...&code=...`; OpenAgentd validates the link shape and forwards the opaque callback payload to the active backend, while the provider remains responsible for state and PKCE verification. Isolated desktop development bundles and physical-device iOS development builds use `openagentd-dev://` so they do not claim the production protocol.
  - A session link can name its server `[v3.52.0]`: `?device=<account device id>` and/or `?server=<base URL>` (and `?srv=`, the app's own token in widget links). The phone opens it on that computer, switching first (the account computer directly on the home network when it can, else through the account); a link without them opens on the server in use, as before. Each link is handled once, so a reload (a server switch, or iOS reloading the app in the background) no longer opens it again, starts another draft, or repeats an OAuth callback.
  - The full set of links `[v3.58.0]`, each also on `openagentd-dev://`. A link opens or fills in; it never sends, approves or installs anything.

    | Link | Opens |
    |---|---|
    | `connect?url=…&key=…` | Adds a server (the QR code) |
    | `session/<id>` (`?srv=`, `?device=`, `?server=`) | That session; one id only, so `session/settings/models` is not a way into other screens |
    | `new` (`?workspace=<path>`, `?prompt=<text>`) | A new-session draft, in the last folder without `workspace`, with any open overlay (Settings, Usage, the scheduler) closed; `prompt` is added to the message box unsent, cut to 8,000 characters, and waits for the box on a cold start |
    | `scheduler` (`?task=<id>`) | The scheduler, on that task |
    | `settings`, `settings/<section>` | Settings, on that section (e.g. `models`); an unknown section opens the first page |
    | `telemetry` (`?days=1\|7\|30\|90`, `?traceId=`, `?session=`) | The telemetry view on that range, trace or session |
    | `auth/callback`, `mcp-oauth` | Finish a provider or connector sign-in |
- **OAuth subscription support** `[v1.8.0]` — Copilot, Codex, others via the
  built-in OAuth helper. Codex models automatically prioritize extended context
  window limits (up to 872k/1M tokens) where supported by the catalog
  `[v2.8.0]`.
- **Grok Build subscription provider** `[v1.112.0]` — `grok:` uses xAI's
  device OAuth flow and refreshable session credentials independently of the
  direct API-key-backed `xai:` provider, with live model discovery and the
  Grok Build proxy's required model-routing headers. Grok billing usage is
  available in Settings, the native usage tray, and the manual provider smoke
  script. The live `/models` catalog picks each model's API (Responses or
  Chat Completions), Grok Build's default context window, and its
  reasoning-effort levels; requests carry the session as `x-grok-conv-id`.
  Usage reads xAI's zero-omitting billing fields as 0%, shows prepaid credits
  in dollars, and falls back to the legacy monthly limit. Token refresh
  retries transient failures and keeps the saved session unless xAI rejects
  the grant `[v3.29.0]`.
- **Codex usage monitor** `[v1.32.0, v1.131.0, v1.131.1]` — Settings → Models shows live Codex
  OAuth usage windows, resets, credits, unlimited plans, and spend-cap/limit states.
  Workspace spend caps report used/limit/remaining amounts and a reset time — the only
  usage signal once a cap is reached and Codex stops returning rate-limit windows — and
  a reached cap drives the panel copy instead of the credits flag `[v1.131.0]`. The
  desktop tray's "Usage Limits" submenu renders the same cap `[v1.131.1]`.
- **Priority / Fast mode** `[v1.90.0, v1.92.0]` — opt new messages into Fast/Priority mode. Supported on models and providers that implement service/latency tiers (Anthropic maps to `auto`, Google Gemini maps to `priority`, OpenAI maps to `auto`, and ChatGPT Codex maps to `priority`). Availability is driven by a `supports_fast_mode` registry flag instead of a hard-coded provider-prefix list, so plugin providers can opt in without frontend changes `[v1.92.0]`. The status bar shows a **fast** pill while the session has it on; it is a status indicator, not a switch, so the mode is set through the API or another client, and the session field, API parameter, and provider mapping apply as before.
- **Hide / show a provider** `[v1.92.0]` — Settings → Models lets you
  temporarily hide a configured provider's models (**Hide** / **Show** in header); its models disappear from
  every picker and the warm-cache loop skips it, while saved credentials stay
  on disk and **Show** restores them. Connected OAuth providers also offer **Disconnect** in the card body (`DELETE /api/auth/{provider}`) to delete saved OAuth account tokens from disk and log out.
  With several accounts, each account row has its own **Remove** instead
  (`DELETE /api/auth/{provider}?credential_id=…`) `[v3.30.0]`.
  A **Hidden** status filter chip lists only hidden providers; they no longer
  count under **Connected** or the header's connected total `[v3.29.0]`.
  A provider that loses its connection (API key deleted, OAuth session revoked or
  refresh rejected) drops its cached model list and saved visible-model selection,
  so pickers stop offering models the provider can no longer serve; connected
  providers keep both — an expired access token is refreshed, not a disconnection.
- **Several keys and accounts per provider, with automatic switching** `[v3.30.0]` —
  Settings → Models keeps an ordered list of API keys for each API-key
  provider (OpenAI, Anthropic, OpenRouter, …) and of OAuth accounts for Codex,
  GitHub Copilot, and Grok. Each row shows a masked key hint or account name and
  its state (In use, Ready, Cooling down with a reset countdown, Reconnect
  required, Disabled), and can be renamed, moved up or down (buttons, not
  drag-only), disabled, reconnected, or removed without touching the others;
  OAuth rows open that account's usage. When the credential in use hits a rate
  limit or quota (429), a spend limit or 402, or is rejected (401/403 after an
  OAuth refresh), the same turn continues on the next ready credential with the
  same model, and the transcript notes the switch. Selection is sticky: it stays
  on the new credential until that one fails. Reordering the list switches to
  the new first ready credential at once. Cooldowns are shared by every
  session and subagent, and title and summary calls skip cooling credentials.
  Only when every credential is cooling down does the agent wait for the
  earliest reset. Keys in one organization often share limits, so extra keys
  don't always add quota. A key exported in the server's environment pins the
  provider and shows as a read-only "From environment" row. Bedrock and
  Vertex AI keep a single credential. Provider plugins keep one too, unless
  they opt in with `supportsMultipleCredentials: true`; they then get the same
  account list, switching, and cooldowns, with per-account OAuth tokens kept in
  `credentials.yaml` `[v3.30.0]`.
  Since `[v3.62.0]` a cooling row turns Ready by itself when its cooldown
  ends, in Settings and in the run picker, instead of showing "resets in 0s"
  until the app read the list again; redeeming a Codex limit reset ends that
  account's cooldown at once, so it is used again without waiting out the
  old reset time.
- **Usage for each enabled OAuth profile** `[v3.39.0]` — Settings → Models
  shows each enabled profile's quota windows, spend caps and credits in its
  own row, without a duplicate provider-wide usage block. Disabled profiles
  do not request usage. Usage checks share a per-account cache across clients
  of the same server; provider rate limits show a retry countdown and pause
  checks until that time, including manual refresh. Last-known measurements
  keep their original timestamp and are marked old. A usage-check rate limit
  does not put the profile's chat requests into cooldown. Plan names and
  currency appear when reported by the provider.
- **Reconnect without restarting** `[v3.12.0]` — when an agent's provider
  can't start (an OAuth login that expired, a missing API key, a network
  failure at load), each new message tries it again. Logging in again or
  saving a key in Settings → Models takes effect on the next message
  instead of after quitting and reopening the app.
- **Copilot usage monitor** `[v1.33.0]` — Settings → Models shows live Copilot
  premium request quota from the saved OAuth token. Token-based / pooled-credit
  seats skip a fake 0% quota window and show used credits as `N/∞` in Settings
  and the usage tray instead of "unlimited" `[v2.23.0]`.
- **API key provider usage and credit monitor** `[v2.3.0]` — Settings → Models shows live credit balances, key spend caps, and quota limits for configured API key providers (such as OpenRouter and DeepSeek) alongside OAuth providers.
- **Provider plugin usage hooks** `[v1.33.0]` — OAuth provider plugins can
  surface live usage in the same Settings → Models panel as built-ins.
- **Provider-scoped visible models and pricing** `[v1.57.0, v1.63.0, v2.9.0]` — Settings → Models lets
  users choose which provider models appear in normal model pickers. Session
  settings and other pickers read a cached provider model list for instant
  open; when the cache is empty, `/api/agents/registry` warms configured
  providers' caches on demand, and **List models** remains the per-provider
  manual refresh / verification action — available whenever credentials are
   already saved, without retyping a secret the UI never echoes back
   `[v1.132.0]`. A model the provider no longer serves is pruned from both the
   cached list and the saved visible selection on the next refresh, and is dropped
   immediately when a chat attempt comes back with a model-not-available error, so
   retired model ids (for example a withdrawn DeepSeek preview) stop being
   selectable. The providers page now includes a
  search plus status/kind filter bar for quickly narrowing long provider lists
  `[v1.74.0]`. Each model row in the listing displays its per-token pricing (USD per 1M tokens
  input/output or `Free` badge) with tooltip breakdowns including cache read/write rates `[v2.9.0]`.
- **Curated multimodal model registry** `[v1.34.0]` — model modality gates,
  token limits, cost, support flags, and thinking-level metadata are maintained
  in one exact-match registry: runtime `models.dev` cache, explicit compatibility
  aliases for runtime provider/model IDs that differ from the upstream source
  IDs, and an optional local YAML overlay.

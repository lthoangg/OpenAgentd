/**
 * OpenAgentd API client — settings group: sandbox, title, multimodal, providers, OAuth.
 */

import { apiBaseUrl } from '../base-url'
import { readSSE } from '../sse'
import type { SSECallbacks } from '../sse'
import { parseDetailOrThrow } from './_shared'

export type DeniedPathsSettings = { denied_patterns: string[] }
export type SandboxSettings = DeniedPathsSettings

export type LspToolsStatus = {
  downloads_enabled: boolean
  python: { ty: boolean; ruff: boolean }
  typescript: {
    state: 'missing' | 'installing' | 'ready' | 'error'
    detail: string | null
    language_server_version: string
    typescript_version: string
  }
}

export async function getLspToolsStatus(): Promise<LspToolsStatus> {
  const res = await fetch(`${apiBaseUrl()}/settings/lsp`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/lsp')
  return res.json()
}

export async function installTypeScriptLsp(): Promise<LspToolsStatus> {
  const res = await fetch(`${apiBaseUrl()}/settings/lsp/typescript/install`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /settings/lsp/typescript/install')
  return res.json()
}

export async function getDeniedPathsSettings(): Promise<DeniedPathsSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/denied-paths`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/denied-paths')
  return res.json()
}

export async function updateDeniedPathsSettings(
  body: DeniedPathsSettings,
): Promise<DeniedPathsSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/denied-paths`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/denied-paths')
  return res.json()
}

export const getSandboxSettings = getDeniedPathsSettings
export const updateSandboxSettings = updateDeniedPathsSettings

export type SummarizationSettings = {
  /** null = use the auto-computed model-aware threshold */
  prompt_token_threshold: number | null
  /** Compact an idle session before its prompt cache expires (opt-in). */
  idle_compaction: boolean
  /** Share (1-100) of the compaction trigger needed for idle compaction; null = 70. */
  idle_compaction_percent: number | null
}

export async function getSummarizationSettings(): Promise<SummarizationSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/summarization`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/summarization')
  return res.json()
}

export async function updateSummarizationSettings(
  body: SummarizationSettings,
): Promise<SummarizationSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/summarization`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/summarization')
  return res.json()
}

export type TitleGenerationSettings = {
  enabled: boolean
  model: string
  wait_timeout_seconds: number
  /** Retitle the session from its summary after each compaction (v3 only). */
  update_after_compaction: boolean
}

export async function getTitleGenerationSettings(): Promise<TitleGenerationSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/title-generation`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/title-generation')
  return res.json()
}

export async function updateTitleGenerationSettings(
  body: TitleGenerationSettings,
): Promise<TitleGenerationSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/title-generation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/title-generation')
  return res.json()
}

export type WorkspaceMessagesSettings = {
  /** Lead agents get the ``workspace`` tool. */
  enabled: boolean
}

export async function getWorkspaceMessagesSettings(): Promise<WorkspaceMessagesSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/workspace-messages`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/workspace-messages')
  return res.json()
}

export async function updateWorkspaceMessagesSettings(
  body: WorkspaceMessagesSettings,
): Promise<WorkspaceMessagesSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/workspace-messages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/workspace-messages')
  return res.json()
}

export type MultimodalSectionSettings = {
  model: string
  [key: string]: string | number | boolean | null
}

export type MultimodalSettings = {
  image: MultimodalSectionSettings
  video: MultimodalSectionSettings
}

export async function getMultimodalSettings(): Promise<MultimodalSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/multimodal`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/multimodal')
  return res.json()
}

export async function updateMultimodalSettings(
  body: MultimodalSettings,
): Promise<MultimodalSettings> {
  const res = await fetch(`${apiBaseUrl()}/settings/multimodal`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/multimodal')
  return res.json()
}

// ── /settings/providers ──────────────────────────────────────────────────────

export type ModelCostInfo = {
  input?: number | null
  output?: number | null
  cache_read?: number | null
  cache_write?: number | null
}

export type ProviderInfo = {
  id: string
  label: string
  description: string
  kind: 'api_key' | 'oauth' | 'local' | 'cloud_creds'
  credentials: Array<{
    name: string
    label: string
    secret: boolean
    required: boolean
    placeholder: string
  }>
  saved_credentials: Record<string, string>
  env_var: string
  env_vars: string[]
  oauth_command: string
  docs_url: string
  is_configured: boolean
  is_saved: boolean
  is_reachable?: boolean | null
  cached_models: string[]
  visible_models: string[]
  is_disconnected: boolean
  supports_fast_mode: boolean
  public_access: boolean
  model_costs?: Record<string, ModelCostInfo>
  /** Stored keys or OAuth accounts, in the order they are tried. */
  stored_credentials?: StoredCredential[]
  /** A key exported in the server's environment overrides the stored ones. */
  env_pinned?: boolean
  /**
   * The provider can hold several keys/accounts (poolable built-ins and
   * plugins that opt in). Omitted by older backends: treat as the previous
   * kind-based behaviour.
   */
  supports_multiple_credentials?: boolean
  /** Usage can be read per stored credential. Omitted by older backends. */
  supports_credential_usage?: boolean
}

export type StoredCredentialStatus = 'ready' | 'cooling_down' | 'needs_reconnect' | 'disabled'

/** One stored credential of a provider. Never carries a secret value. */
export type StoredCredential = {
  id: string
  label: string
  disabled: boolean
  kind: 'api_key' | 'oauth'
  /** Last characters of the key, e.g. `…3f9a`. */
  hint: string | null
  /** Non-secret values saved with it (base URLs, project ids). */
  settings: Record<string, string>
  status: StoredCredentialStatus
  in_use: boolean
  /** Unix seconds when a cooling-down credential is tried again. */
  cooldown_until: number | null
  cooldown_reason: 'rate_limit' | 'quota' | 'spend_limit' | 'auth' | string | null
}

export type ProviderCredentialsBody = {
  provider: string
  credentials: StoredCredential[]
  env_pinned?: boolean
}

export type ProvidersListBody = {
  providers: ProviderInfo[]
  has_any_configured: boolean
}

export type ProviderSaveRequest = {
  api_key?: string
  extra?: Record<string, string>
}

export type ProviderModelsResponse = {
  provider: string
  models: string[]
  source: 'provider'
  model_costs?: Record<string, ModelCostInfo>
}

export type ProviderUsageWindow = {
  used_percent: number
  window_minutes?: number | null
  resets_at?: number | null
}

export type ProviderUsageLimit = {
  limit_id?: string | null
  limit_name?: string | null
  primary?: ProviderUsageWindow | null
  secondary?: ProviderUsageWindow | null
  credits?: {
    has_credits: boolean
    unlimited: boolean
    balance?: string | null
  } | null
  /** A spend cap. `reached` is authoritative over `credits.has_credits`. */
  spend?: {
    reached: boolean
    source?: string | null
    limit?: number | null
    used?: number | null
    remaining?: number | null
    used_percent?: number | null
    resets_at?: number | null
  } | null
  plan_type?: string | null
  rate_limit_reached_type?: string | null
  reset_credits_available?: number | null
  period_start_at?: number | null
  period_end_at?: number | null
}

export type ProviderUsageResponse = {
  provider: string
  limits: ProviderUsageLimit[]
}

export type ProviderSaveResponse = {
  saved: boolean
  /**
   * `<provider>:<model>` the save gave to agents that had no model yet;
   * `null` when no agent was waiting. Omitted by older backends.
   */
  default_model?: string | null
  agents_updated?: string[]
}

export type ProviderVisibleModelsResponse = {
  provider: string
  visible_models: string[]
}

export type ProviderTestResponse = {
  ok: boolean
  latency_ms?: number | null
  error?: string | null
}

export type DefaultModelResponse = {
  agents_updated: string[]
  /** The model that was applied. Omitted by older backends. */
  provider_model?: string
}

export type OAuthLoginEvent = {
  event: string
  message?: string
  verification_uri?: string
  user_code?: string
  expires_in?: number
  elapsed_s?: number
  suggested_model?: string
  reason?: string
  /** Account this login writes to; sent by multi-credential plugins on every progress event. */
  credential_id?: string
}

export async function listProviders(): Promise<ProvidersListBody> {
  const res = await fetch(`${apiBaseUrl()}/settings/providers`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/providers')
  return res.json()
}

export async function saveProvider(
  providerId: string,
  body: ProviderSaveRequest,
): Promise<ProviderSaveResponse> {
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /settings/providers/${providerId}`)
  return res.json()
}

export async function testProvider(
  providerId: string,
  body: { api_key?: string; model: string; extra?: Record<string, string> },
): Promise<ProviderTestResponse> {
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/test`)
  return res.json()
}

export async function listProviderModels(
  providerId: string,
  body: { api_key?: string; extra?: Record<string, string> },
): Promise<ProviderModelsResponse> {
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/models`)
  return res.json()
}

export async function saveProviderVisibleModels(
  providerId: string,
  models: string[],
): Promise<ProviderVisibleModelsResponse> {
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/visible-models`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /settings/providers/${providerId}/visible-models`)
  return res.json()
}

export async function getProviderUsage(providerId: string, credentialId?: string): Promise<ProviderUsageResponse> {
  const query = credentialId ? `?credential_id=${encodeURIComponent(credentialId)}` : ''
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/usage${query}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /settings/providers/${providerId}/usage`)
  return res.json()
}

export type ProviderDisconnectResponse = {
  provider: string
  is_disconnected: boolean
}

export async function resetProviderUsage(providerId: string, credentialId?: string): Promise<ProviderUsageResponse> {
  const query = credentialId ? `?credential_id=${encodeURIComponent(credentialId)}` : ''
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/reset${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/reset`)
  return res.json()
}

export async function disconnectProvider(
  providerId: string,
  disconnected: boolean,
): Promise<ProviderDisconnectResponse> {
  const res = await fetch(
    `${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/disconnect`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disconnected }),
    },
  )
  if (!res.ok) await parseDetailOrThrow(res, `PUT /settings/providers/${providerId}/disconnect`)
  return res.json()
}

/**
 * Set a model on every agent that has none yet: an explicit
 * `<provider>:<model>`, or `{ provider }` to let the server pick that
 * provider's suggested model from its live list.
 */
export async function configureDefaultModel(target: string | { provider: string }): Promise<DefaultModelResponse> {
  const body = typeof target === 'string' ? { provider_model: target } : { provider: target.provider }
  const res = await fetch(`${apiBaseUrl()}/settings/default-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /settings/default-model')
  return res.json()
}

export function oauthLoginStream(
  providerId: string,
  callbacks: SSECallbacks & { onOAuthEvent?: (event: OAuthLoginEvent) => void },
  signal?: AbortSignal,
  mode?: 'browser',
  /** Reconnect this account; without it a new account is added. */
  credentialId?: string,
): void {
  const params = new URLSearchParams()
  if (mode) params.set('mode', mode)
  if (credentialId) params.set('credential_id', credentialId)
  const query = params.toString() ? `?${params.toString()}` : ''
  fetch(`${apiBaseUrl()}/auth/${encodeURIComponent(providerId)}/login${query}`, { signal })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /auth/${providerId}/login failed: ${res.status}`)
      readSSE(res, {
        ...callbacks,
        onEvent: (type, data) => {
          const payload = data as Omit<OAuthLoginEvent, 'event'>
          callbacks.onOAuthEvent?.({ event: type, ...payload })
          callbacks.onEvent(type, data)
        },
      })
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}

/** Sign out one account (`credentialId`) or every account of the provider. */
export async function disconnectOauthProvider(providerId: string, credentialId?: string): Promise<{ ok: boolean; provider: string }> {
  const query = credentialId ? `?credential_id=${encodeURIComponent(credentialId)}` : ''
  const res = await fetch(`${apiBaseUrl()}/auth/${encodeURIComponent(providerId)}${query}`, {
    method: 'DELETE',
  })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /auth/${providerId}`)
  return res.json()
}

export async function submitOAuthCallback(
  providerId: string,
  code: string,
  /** Account the login stream reported (or the one being reconnected). */
  credentialId?: string,
): Promise<{ ok: boolean; suggested_model?: string }> {
  const res = await fetch(`${apiBaseUrl()}/auth/${encodeURIComponent(providerId)}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentialId ? { code, credential_id: credentialId } : { code }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /auth/${providerId}/callback`)
  return res.json()
}

// ── /settings/providers/{id}/credentials ────────────────────────────────────

function credentialsUrl(providerId: string, credentialId?: string): string {
  const base = `${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/credentials`
  return credentialId ? `${base}/${encodeURIComponent(credentialId)}` : base
}

/** Add another key (or set of values) to a provider. */
export async function addProviderCredential(
  providerId: string,
  body: { label?: string; api_key?: string; extra?: Record<string, string> },
): Promise<StoredCredential & Pick<ProviderSaveResponse, 'default_model' | 'agents_updated'>> {
  const res = await fetch(credentialsUrl(providerId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/credentials`)
  return res.json()
}

/** Rename, enable/disable, or replace values of one credential. */
export async function updateProviderCredential(
  providerId: string,
  credentialId: string,
  body: { label?: string; disabled?: boolean; api_key?: string; extra?: Record<string, string> },
): Promise<StoredCredential> {
  const res = await fetch(credentialsUrl(providerId, credentialId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PATCH /settings/providers/${providerId}/credentials/${credentialId}`)
  return res.json()
}

export async function deleteProviderCredential(providerId: string, credentialId: string): Promise<{ ok: boolean }> {
  const res = await fetch(credentialsUrl(providerId, credentialId), { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /settings/providers/${providerId}/credentials/${credentialId}`)
  return res.json()
}

/** Set the priority order; `ids` must list every credential once. */
export async function orderProviderCredentials(providerId: string, ids: string[]): Promise<ProviderCredentialsBody> {
  const res = await fetch(`${credentialsUrl(providerId)}/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /settings/providers/${providerId}/credentials/order`)
  return res.json()
}

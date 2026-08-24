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
  period_start_at?: number | null
  period_end_at?: number | null
}

export type ProviderUsageResponse = {
  provider: string
  limits: ProviderUsageLimit[]
}

export type ProviderSaveResponse = {
  saved: boolean
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

export async function getProviderUsage(providerId: string, apiKey?: string): Promise<ProviderUsageResponse> {
  const query = apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''
  const res = await fetch(`${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}/usage${query}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /settings/providers/${providerId}/usage`)
  return res.json()
}

export type ProviderDisconnectResponse = {
  provider: string
  is_disconnected: boolean
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

export async function configureDefaultModel(providerModel: string): Promise<DefaultModelResponse> {
  const res = await fetch(`${apiBaseUrl()}/settings/default-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_model: providerModel }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /settings/default-model')
  return res.json()
}

export function oauthLoginStream(
  providerId: string,
  callbacks: SSECallbacks & { onOAuthEvent?: (event: OAuthLoginEvent) => void },
  signal?: AbortSignal,
  mode?: 'browser',
): void {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : ''
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

export async function disconnectOauthProvider(providerId: string): Promise<{ ok: boolean; provider: string }> {
  const res = await fetch(`${apiBaseUrl()}/auth/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /auth/${providerId}`)
  return res.json()
}

export async function submitOAuthCallback(providerId: string, code: string): Promise<{ ok: boolean; suggested_model?: string }> {
  const res = await fetch(`${apiBaseUrl()}/auth/${encodeURIComponent(providerId)}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /auth/${providerId}/callback`)
  return res.json()
}

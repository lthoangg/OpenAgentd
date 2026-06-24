import type { OAuthLoginEvent, ProviderInfo } from '@/api/client'
import { isTransientNetworkError } from '@/utils/errors'

export const MODEL_LONG_PRESS_MS = 520
export const MODEL_LONG_PRESS_MOVE_TOLERANCE = 10

export function providerKindLabel(kind: ProviderInfo['kind']): string {
  if (kind === 'api_key') return 'API key'
  if (kind === 'oauth') return 'OAuth'
  if (kind === 'local') return 'Local'
  return 'Cloud credentials'
}

/** Daemon-style providers expose an optional base URL so users can point
 *  at a proxy running on another host. Each entry names the env var the
 *  backend reads (and persists via the Save endpoint) plus a placeholder
 *  showing the default the daemon would normally listen on. */
export const DAEMON_BASE_URL: Record<string, { var: string; placeholder: string }> = {
  router9: { var: 'ROUTER9_BASE_URL', placeholder: 'http://localhost:20128/v1' },
  cliproxy: { var: 'CLIPROXY_BASE_URL', placeholder: 'http://localhost:8317/v1' },
  ollama: { var: 'OLLAMA_BASE_URL', placeholder: 'http://localhost:11434/v1' },
}

export function eventLabel(event: OAuthLoginEvent): string {
  if (event.event === 'started') return 'Starting secure login'
  if (event.event === 'device_code') return 'Waiting for browser approval'
  if (event.event === 'polling' && typeof event.elapsed_s === 'number') return `Still waiting (${event.elapsed_s}s)`
  if (event.event === 'token_acquired') return 'Token received'
  if (event.event === 'verifying') return 'Verifying provider access'
  if (event.event === 'success') return 'Connected'
  if (event.event === 'failed') return 'Connection failed'
  return event.message || event.event.replaceAll('_', ' ')
}

export function isBenignOAuthStreamClose(message: string): boolean {
  return isTransientNetworkError(new Error(message))
}


export function deviceCodeHelp(providerId: string): string {
  if (providerId === 'codex') {
    return 'Use this code for personal ChatGPT accounts. Keep this dialog open while the browser approves access.'
  }
  if (providerId === 'copilot') {
    return 'Use this code on GitHub to authorize Copilot. Keep this dialog open while GitHub approves access.'
  }
  return 'Use this code on the authorization page. Keep this dialog open while access is approved.'
}

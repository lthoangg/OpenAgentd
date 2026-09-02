import type { ModelCostInfo, OAuthLoginEvent, ProviderInfo } from '@/api/client'
import { isTransientNetworkError } from '@/utils/errors'

export const MODEL_LONG_PRESS_MS = 520
export const MODEL_LONG_PRESS_MOVE_TOLERANCE = 10

export function providerKindLabel(kind: ProviderInfo['kind']): string {
  if (kind === 'api_key') return 'API key'
  if (kind === 'oauth') return 'OAuth'
  if (kind === 'local') return 'Local'
  return 'Cloud credentials'
}

export function formatTokenPrice(usdPerMillion: number): string {
  if (usdPerMillion === 0) return '$0'
  if (Number.isInteger(usdPerMillion)) {
    return `$${usdPerMillion}`
  }
  if (usdPerMillion < 0.1) {
    return `$${usdPerMillion.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  }
  return `$${usdPerMillion.toFixed(2)}`
}

export function formatModelPriceBadge(cost?: ModelCostInfo): { label: string; isFree: boolean } | null {
  if (!cost) return null
  const { input, output } = cost
  const hasInput = typeof input === 'number'
  const hasOutput = typeof output === 'number'

  if (!hasInput && !hasOutput) return null

  if (input === 0 && output === 0) {
    return { label: 'Free', isFree: true }
  }

  if (hasInput && hasOutput) {
    return {
      label: `${formatTokenPrice(input)} / ${formatTokenPrice(output)} / 1M`,
      isFree: false,
    }
  }

  if (hasInput) {
    return {
      label: `${formatTokenPrice(input)} in / 1M`,
      isFree: false,
    }
  }

  return {
    label: `${formatTokenPrice(output!)} out / 1M`,
    isFree: false,
  }
}

export function formatModelPriceTooltip(cost?: ModelCostInfo): string | null {
  if (!cost) return null
  const { input, output, cache_read, cache_write } = cost
  const hasInput = typeof input === 'number'
  const hasOutput = typeof output === 'number'
  const hasCacheRead = typeof cache_read === 'number'
  const hasCacheWrite = typeof cache_write === 'number'

  if (!hasInput && !hasOutput && !hasCacheRead && !hasCacheWrite) return null

  if (input === 0 && output === 0 && !hasCacheRead && !hasCacheWrite) {
    return 'Free (no token cost)'
  }

  const lines: string[] = []
  if (hasInput) {
    lines.push(`Input: ${formatTokenPrice(input)} / 1M tokens`)
  }
  if (hasOutput) {
    lines.push(`Output: ${formatTokenPrice(output)} / 1M tokens`)
  }
  if (hasCacheRead) {
    lines.push(`Cache read: ${formatTokenPrice(cache_read)} / 1M tokens`)
  }
  if (hasCacheWrite) {
    lines.push(`Cache write: ${formatTokenPrice(cache_write)} / 1M tokens`)
  }

  return lines.join(' · ')
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Gateway/edge statuses that clear on their own: 502/503/504 and Cloudflare
// 520–524. Word-bounded so "5030 tokens" or "port 5200" do not match.
const GATEWAY_STATUS_RE = /\b(50[234]|52[0-4])\b/
// "timed out" is always an event. Bare "timeout" is also a noun ("timeout
// must be a number"), so it only counts with request/connection framing.
const TIMEOUT_RE =
  /\btimed out\b|\berr_timed_out\b|\betimedout\b|\b(request|connection|connect|read|socket|stream|gateway)\b[^.]{0,30}\btimeout\b/

export function isTransientNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }
  const message = errorMessage(err).toLowerCase()
  if (GATEWAY_STATUS_RE.test(message) || TIMEOUT_RE.test(message)) return true
  return (
    message.includes('load failed') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network error') ||
    message.includes('network request failed') ||
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('connection closed') ||
    message.includes('connection aborted') ||
    message.includes('err_connection_') ||
    message.includes('err_network_') ||
    message.includes('err_internet_disconnected') ||
    message.includes('err_name_not_resolved') ||
    message.includes('err_empty_response') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('enetdown') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed')
  )
}

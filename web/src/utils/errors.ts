export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isTransientNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }
  const message = errorMessage(err).toLowerCase()
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
    message.includes('err_timed_out') ||
    message.includes('err_empty_response') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('abort') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('enetdown') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('520') ||
    message.includes('521') ||
    message.includes('522') ||
    message.includes('523') ||
    message.includes('524')
  )
}

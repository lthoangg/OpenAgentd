export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isTransientNetworkError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase()
  return (
    message.includes('load failed') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed')
  )
}

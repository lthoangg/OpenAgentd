/**
 * A session opened from a desktop widget (the island, the pet) comes forward
 * without focus in its composer: the user was elsewhere and only looked in.
 * The shell says so with `quiet` on `desktop-notification-clicked`, or with
 * `?quiet=1` on a new window's first route. The chat view takes the mark
 * once, when it would otherwise start in the composer.
 */
let quiet: string | null = null

export function markQuietOpen(sessionId: string): void {
  quiet = sessionId
}

/** Whether `sessionId` was opened quietly; clears the mark. */
export function takeQuietOpen(sessionId: string | null): boolean {
  if (!sessionId || quiet !== sessionId) return false
  quiet = null
  return true
}

/** A new window's first route: marks a `?quiet=1` open and returns the route without it. */
export function takeQuietOpenFromRoute(route: string | undefined): string | undefined {
  if (!route) return route
  const [path, query = ''] = route.split('?', 2)
  const params = new URLSearchParams(query)
  if (params.get('quiet') !== '1') return route
  params.delete('quiet')
  const sessionId = path.replace(/^\/+/, '').split(/[/#]/)[0]
  if (sessionId) markQuietOpen(sessionId)
  const rest = params.toString()
  return rest ? `${path}?${rest}` : path
}

export function _resetQuietOpenForTests(): void {
  quiet = null
}

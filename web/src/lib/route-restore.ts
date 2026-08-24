export function closestRestorableRoute(route: string): string {
  const trimmed = route.trim()
  if (!trimmed) return '/'

  const pathMatch = trimmed.match(/^[^?#]*/)
  const pathOnly = pathMatch?.[0] ?? trimmed
  const suffix = trimmed.slice(pathOnly.length)
  if (pathOnly === '/index.html') return `/${suffix}`
  if (pathOnly.startsWith('/coding/')) return `/coding${suffix}`
  if (pathOnly === '/cockpit' || pathOnly.startsWith('/cockpit/')) return `/coding${suffix}`
  if (pathOnly.startsWith('/settings')) return '/'
  return trimmed
}

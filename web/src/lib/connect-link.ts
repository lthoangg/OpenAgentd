/**
 * `openagentd://connect` links: the desktop Network access card shows one as
 * a QR code, and the mobile app opens its Backend connection dialog with the
 * address and access key filled in. The link never connects by itself; the
 * user confirms with Save & Connect.
 */

export interface ConnectLink {
  /** Candidate server origins, in the order the desktop listed them. */
  urls: string[]
  key: string
}

const MAX_URLS = 8
const MAX_KEY_LENGTH = 512

/** Always the release scheme: the scan targets the mobile app. */
export function buildConnectLink({ urls, key }: ConnectLink): string {
  const params = new URLSearchParams()
  for (const url of urls) params.append('url', url)
  params.set('key', key)
  return `openagentd://connect?${params.toString()}`
}

function normalizeServerOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== '' && path !== '/api') return null
    if (url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

export function parseConnectLink(raw: string): ConnectLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'openagentd:' && url.protocol !== 'openagentd-dev:') return null
  if (url.host !== 'connect' || (url.pathname !== '' && url.pathname !== '/')) return null

  const urls: string[] = []
  for (const candidate of url.searchParams.getAll('url')) {
    const origin = normalizeServerOrigin(candidate)
    if (origin && !urls.includes(origin)) urls.push(origin)
    if (urls.length === MAX_URLS) break
  }
  const key = url.searchParams.get('key')?.trim() ?? ''
  if (!urls.length || !key || key.length > MAX_KEY_LENGTH) return null
  return { urls, key }
}

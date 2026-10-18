/** Quick reachability and access-key checks for a candidate backend origin. */

const PROBE_TIMEOUT_MS = 1500

export async function checkServerAuth(baseUrl: string, accessKey: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const headers = accessKey ? { Authorization: `Bearer ${accessKey}` } : undefined
    const res = await fetch(`${base}/api/auth/check`, { cache: 'no-store', headers, signal: controller.signal })
    return res.ok || res.status === 404
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function pingServer(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/api/health/live`, { cache: 'no-store', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

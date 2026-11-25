/**
 * The page the desktop app's hidden agent-page window frames, from its
 * address (`?src=`), or null when it is not one this window may frame.
 *
 * Only a preview listener qualifies: plain http on 127.0.0.1 and a port
 * above 1024, no credentials. The listener proxies the agent's page and
 * injects the script that takes the agent's commands.
 */
export function agentPageSrc(search: string): string | null {
  const raw = new URLSearchParams(search).get('src')
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !(port > 1024) || url.username || url.password) return null
  return url.href
}

/** Same sandbox as the Browser tab: the page's own origin, no top navigation. */
export const AGENT_PAGE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'

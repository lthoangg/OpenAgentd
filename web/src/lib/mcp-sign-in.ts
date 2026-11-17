/**
 * A connector's sign-in, driven from the device the user is holding, so it
 * works wherever the server runs.
 *
 * The server hands back the service's sign-in page. A browser opens it in a
 * window it opened on the click (so no popup blocker stops it); the apps open
 * it in the system browser. The code comes back to the server's localhost
 * listener when the browser is on the server's machine, else through the
 * relay page to this client's `oauth-done.html` page or `openagentd://mcp-oauth`
 * link, which hands it to the server. Meanwhile this waits on the server.
 */
import {
  cancelMcpSignIn,
  finishMcpSignIn,
  getMcpSignInStatus,
  startMcpSignIn,
  type McpSignInCode,
  type ServerStatus,
} from '@/api/client/mcp'
import { getPlatform } from '@/hooks/use-platform'
import { openExternalUrl } from '@/lib/open-external'

/** How often to ask the server whether the sign-in finished. */
export const SIGN_IN_POLL_MS = 1_500
/** A little longer than the server waits for the code. */
export const SIGN_IN_TIMEOUT_MS = 11 * 60_000

/** The link scheme of this build of the apps. */
export function appLinkScheme(): 'openagentd' | 'openagentd-dev' {
  const { os } = getPlatform()
  const phone = os === 'ios' || os === 'android'
  return import.meta.env.DEV && !phone ? 'openagentd-dev' : 'openagentd'
}

/** Where the relay page sends the code on to, for this client. */
export function signInReturnTo(location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  if (getPlatform().isTauri) return `${appLinkScheme()}://mcp-oauth`
  // The page sits beside index.html, wherever the app is served from.
  const base = location.pathname.replace(/[^/]*$/, '')
  return `${location.origin}${base}oauth-done.html`
}

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled.')
    this.name = 'SignInCancelled'
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for the server to finish `name`'s sign-in. */
export async function waitForSignIn(name: string, opts: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number } = {}): Promise<ServerStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new SignInCancelled()
    const s = await getMcpSignInStatus(name)
    if (s.status === 'done') return s.server
    if (s.status === 'failed') throw new Error(s.error)
    if (s.status === 'none') throw new Error(`The sign-in to ${name} is no longer running. Try again.`)
    await sleep(opts.pollMs ?? SIGN_IN_POLL_MS)
  }
  throw new Error(`Timed out waiting for the sign-in to ${name}.`)
}

/**
 * The window a browser shows the sign-in page in, opened now (on the click)
 * so no popup blocker stops it; `null` in the apps, which use the system
 * browser. For a caller that has work to do before the sign-in starts.
 */
export function openSignInWindow(): Window | null {
  if (getPlatform().isTauri) return null
  let popup: Window | null = null
  try {
    popup = window.open('', '_blank')
    // The service's page must not reach back into this window.
    if (popup) popup.opener = null
  } catch {
    // No window (blocked, or a runtime without one): the page opens in a tab instead.
  }
  return popup
}

/**
 * Sign in to `name`. Call it straight from the click: a browser needs the
 * click to open the sign-in window.
 */
export async function signInToMcpServer(name: string, opts: { signal?: AbortSignal; popup?: Window | null } = {}): Promise<ServerStatus> {
  const popup = opts.popup !== undefined ? opts.popup : openSignInWindow()
  const onAbort = () => {
    popup?.close()
    void cancelMcpSignIn(name).catch(() => {})
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const started = await startMcpSignIn(name, signInReturnTo())
    if (started.status === 'done') {
      popup?.close()
      return started.server
    }
    if (popup && !popup.closed) popup.location.href = started.auth_url
    else await openExternalUrl(started.auth_url)
    return await waitForSignIn(name, { signal: opts.signal })
  } catch (err) {
    popup?.close()
    throw err
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** The code and state a returned address carries, or null. */
export function codeFromReturn(params: URLSearchParams): { code: string; state: string; iss: string | null } | { error: string; state: string | null } | null {
  const error = params.get('error')
  if (error) return { error: params.get('error_description') || error, state: params.get('state') }
  const code = params.get('code')?.trim()
  const state = params.get('state')?.trim()
  if (!code || !state) return null
  return { code, state, iss: params.get('iss') }
}

/**
 * The server a relayed `state` names (`<random>.<base64url JSON>`), for a
 * page that has to say which sign-in it is finishing. Not trusted for
 * anything else: the server matches the whole state.
 */
export function serverFromState(state: string | null): string | null {
  const info = state?.split('.')[1]
  if (!info) return null
  try {
    const json = atob(info.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed: unknown = JSON.parse(json)
    const server = (parsed as { server?: unknown })?.server
    return typeof server === 'string' && server ? server : null
  } catch {
    return null
  }
}

/**
 * Hand a returned code (or a pasted address) to the server. A sign-in the
 * user refused at the service is cancelled.
 */
export async function deliverSignInCode(input: McpSignInCode | { error: string; state: string | null }): Promise<{ name: string | null; server?: ServerStatus }> {
  if ('error' in input) {
    const name = serverFromState(input.state)
    if (name) await cancelMcpSignIn(name).catch(() => {})
    throw new Error(input.error === 'access_denied' ? 'Sign-in was declined.' : `Sign-in failed: ${input.error}`)
  }
  const res = await finishMcpSignIn(input)
  return { name: res.name, server: res.server }
}

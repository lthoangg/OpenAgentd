/**
 * Short opaque names for the servers this app uses, for links that must say
 * which server a session is on without carrying its address: a home-screen
 * widget's storage is readable by another process and never holds a server
 * address (`mobile/src-tauri/src/widgets.rs`), so its session links carry
 * `?srv=<token>` and the app maps the token back here.
 */
import type { NotificationTarget } from '@/lib/notification-taps'

export type ServerRef = Pick<NotificationTarget, 'baseUrl' | 'deviceId'>

const STORAGE_KEY = 'oa-server-refs'
/** Servers remembered; the oldest goes first. */
const MAX_REFS = 20
/** What a token looks like (also checked by the shell). */
export const SERVER_TOKEN_PATTERN = /^[a-z0-9]{8,32}$/

type Refs = Record<string, ServerRef>

function readRefs(): Refs {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const refs: Refs = {}
    for (const [token, ref] of Object.entries(parsed)) {
      if (!SERVER_TOKEN_PATTERN.test(token) || !ref || typeof ref !== 'object') continue
      const { baseUrl, deviceId } = ref as Record<string, unknown>
      if (typeof baseUrl !== 'string' && typeof deviceId !== 'string') continue
      refs[token] = {
        ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
        ...(typeof deviceId === 'string' ? { deviceId } : {}),
      }
    }
    return refs
  } catch {
    return {}
  }
}

/** An account computer is the same one by any address; anything else by its address. */
function sameServer(a: ServerRef, b: ServerRef): boolean {
  if (a.deviceId || b.deviceId) return a.deviceId === b.deviceId
  return a.baseUrl === b.baseUrl
}

function newToken(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12)
}

/** The token for this server, made on first use. Null when there is no server to name. */
export function serverToken(ref: ServerRef): string | null {
  if (!ref.baseUrl && !ref.deviceId) return null
  const refs = readRefs()
  const known = Object.entries(refs).find(([, r]) => sameServer(r, ref))
  if (known) {
    // Keep the newest address of an account computer (bridge ports change).
    if (known[1].baseUrl === ref.baseUrl) return known[0]
    refs[known[0]] = ref
    write(refs)
    return known[0]
  }
  const token = newToken()
  const entries = Object.entries({ ...refs, [token]: ref })
  write(Object.fromEntries(entries.slice(-MAX_REFS)))
  return token
}

function write(refs: Refs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(refs))
  } catch {
    // Storage full or blocked: links then open on the server in use.
  }
}

/** The server a token names, or null when this app never made it. */
export function serverForToken(token: string): ServerRef | null {
  if (!SERVER_TOKEN_PATTERN.test(token)) return null
  return readRefs()[token] ?? null
}

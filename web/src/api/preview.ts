/**
 * Built-in web preview client (`/api/preview`, v3 only).
 *
 * The backend starts a loopback listener per preview target and returns its
 * origin (`http://127.0.0.1:<port>`). The dock frames that origin, which is
 * separate from the app, so the previewed page cannot reach the app's
 * storage or access key.
 *
 * That listener is on the *server's* loopback. When the backend runs on
 * another device, the native shell (mobile app, desktop window on a remote
 * server) runs a relay on this device's loopback that tunnels to it
 * (`preview_relay_open`), and the dock frames the relay's origin instead.
 * A plain browser on another device has no relay, so it cannot preview.
 */

import { apiBaseUrl } from './base-url'
import { parseDetailOrThrow } from './client/_shared'
import { getPlatform } from '@/hooks/use-platform'

/** What a preview tab shows: a local dev server URL or a workspace file. */
export type PreviewTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string }

export interface PreviewInfo {
  id: string
  workspace: string
  kind: 'url' | 'file'
  /** Proxied origin (`http://localhost:5173`) or the served directory. */
  target: string
  /** The listener's port on the server (also when framed through a relay). */
  port: number
  /** Where the iframe loads from, e.g. `http://127.0.0.1:52011` (the relay's origin in relay mode). */
  origin: string
  /** First path to open (with query and hash). */
  path: string
  url: string
  console_errors: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** True when the backend runs on this computer, so its preview listeners are reachable. */
export function isLocalBackend(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const base = new URL(apiBaseUrl(), window.location.href)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return false
    return isLoopbackHost(base.hostname)
  } catch {
    return false
  }
}

/**
 * How this client reaches preview listeners: `direct` when the backend is on
 * this computer, `relay` through the native shell's loopback relay, or
 * `unavailable` (a browser on another device).
 */
export type PreviewMode = 'direct' | 'relay' | 'unavailable'

export function previewMode(): PreviewMode {
  if (isLocalBackend()) return 'direct'
  return getPlatform().isTauri ? 'relay' : 'unavailable'
}

export function previewsAvailable(): boolean {
  return previewMode() !== 'unavailable'
}

interface RelayInfo {
  port: number
  origin: string
}

/** Start (or reuse) the native relay for a preview; the shell holds the server URL and key. */
async function openRelay(info: PreviewInfo): Promise<RelayInfo> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<RelayInfo>('preview_relay_open', { previewId: info.id, port: info.port })
}

export function previewTargetKey(target: PreviewTarget): string {
  if (target.kind === 'file') return `file:${target.path}`
  try {
    const u = new URL(target.url.includes('://') ? target.url : `http://${target.url}`)
    return `url:${u.protocol}//${u.host}`
  } catch {
    return `url:${target.url}`
  }
}

const PORT_KEY = 'oa-preview-port:'
const LAST_URL_KEY = 'oa-preview-last-url:'

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function preferredPort(workspace: string, target: PreviewTarget): number | undefined {
  const key = target.kind === 'file' ? 'files' : previewTargetKey(target)
  const raw = storage()?.getItem(`${PORT_KEY}${workspace}|${key}`)
  const port = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(port) && port > 1024 && port < 65536 ? port : undefined
}

function rememberPort(workspace: string, target: PreviewTarget, port: number): void {
  const key = target.kind === 'file' ? 'files' : previewTargetKey(target)
  storage()?.setItem(`${PORT_KEY}${workspace}|${key}`, String(port))
}

export function lastPreviewUrl(workspace: string): string | null {
  return storage()?.getItem(`${LAST_URL_KEY}${workspace}`) ?? null
}

export function rememberPreviewUrl(workspace: string, url: string): void {
  storage()?.setItem(`${LAST_URL_KEY}${workspace}`, url)
}

/**
 * Start (or reuse) the preview for `target`. Reuses the port this target had
 * last time when it is free, so the page keeps its cookies and storage.
 * In relay mode the returned `origin` and `url` point at the relay.
 */
export async function openPreview(workspace: string, target: PreviewTarget): Promise<PreviewInfo> {
  const body: Record<string, unknown> = { workspace }
  if (target.kind === 'url') body.url = target.url
  else body.path = target.path
  const port = preferredPort(workspace, target)
  if (port) body.preferred_port = port
  const res = await fetch(`${apiBaseUrl()}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'openPreview')
  const info = (await res.json()) as PreviewInfo
  rememberPort(workspace, target, info.port)
  if (target.kind === 'url') rememberPreviewUrl(workspace, target.url)
  if (previewMode() !== 'relay') return info
  const relay = await openRelay(info)
  return { ...info, origin: relay.origin, url: `${relay.origin}${info.path}` }
}

export async function closePreview(id: string): Promise<void> {
  if (previewMode() === 'relay') {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('preview_relay_close', { previewId: id }))
      .catch(() => {})
  }
  const res = await fetch(`${apiBaseUrl()}/preview/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await parseDetailOrThrow(res, 'closePreview')
}

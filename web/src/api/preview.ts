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
 * A computer of the account counts as another device too: the app reaches
 * it through a bridge on this device's loopback, so its address looks local
 * while its preview listeners are not.
 * A plain browser on another device has no relay, so it cannot preview.
 */

import { apiBaseUrl } from './base-url'
import { parseDetailOrThrow } from './client/_shared'
import { getPlatform } from '@/hooks/use-platform'
import { isMobileApp } from '@/lib/mobile-app'
import { isAccountBridgeUrl } from '@/lib/app-backend'

/** What a preview tab shows: a local dev server URL or a workspace file. */
export type PreviewTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string }

export interface PreviewInfo {
  id: string
  workspace: string
  /** `site`: a page on another machine, shown by the desktop app's own view (see `openSitePage`). */
  kind: 'url' | 'file' | 'site'
  /** Proxied origin (`http://localhost:5173`), the served directory, or the site's origin. */
  target: string
  /** The listener's port on the server (also when framed through a relay). */
  port: number
  /** Where the iframe loads from, e.g. `http://127.0.0.1:52011` (the relay's origin in relay mode). */
  origin: string
  /** First path to open (with query and hash). */
  path: string
  url: string
  console_errors: number
  /** What the agent opened here and still uses, or null (see `listAgentPages`). */
  agent_page?: PreviewTarget | null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * True when the backend runs on this computer, so its preview listeners are
 * reachable. Never in the phone app (no server runs on a phone), nor on an
 * account bridge (a loopback address that relays to another computer).
 */
export function isLocalBackend(): boolean {
  if (typeof window === 'undefined') return false
  if (isMobileApp(getPlatform())) return false
  try {
    const base = new URL(apiBaseUrl(), window.location.href)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return false
    return isLoopbackHost(base.hostname) && !isAccountBridgeUrl(base.href)
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
const RECENT_URLS_KEY = 'oa-preview-recent-urls:'
const MAX_RECENT_URLS = 5

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
  addRecentPreviewUrl(workspace, url)
}

/** The addresses previewed last in `workspace` on this device, newest first. */
export function recentPreviewUrls(workspace: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(`${RECENT_URLS_KEY}${workspace}`) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === 'string').slice(0, MAX_RECENT_URLS) : []
  } catch {
    return []
  }
}

/** Put `url` first among the workspace's recent addresses (the address bar suggests them). */
export function addRecentPreviewUrl(workspace: string, url: string): void {
  const full = url.includes('://') ? url : `http://${url}`
  const next = [full, ...recentPreviewUrls(workspace).filter((item) => item !== full)].slice(0, MAX_RECENT_URLS)
  storage()?.setItem(`${RECENT_URLS_KEY}${workspace}`, JSON.stringify(next))
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

/**
 * Close a preview's listener. With `keepAgentPage` (a Preview tab closing),
 * the server keeps a listener whose page the agent still uses, and this
 * answers false: the page stays loaded out of sight instead.
 */
export async function closePreview(id: string, { keepAgentPage = false }: { keepAgentPage?: boolean } = {}): Promise<boolean> {
  const query = keepAgentPage ? '?keep_agent_page=1' : ''
  const res = await fetch(`${apiBaseUrl()}/preview/${encodeURIComponent(id)}${query}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await parseDetailOrThrow(res, 'closePreview')
  if (res.status === 200) {
    const body = (await res.json().catch(() => ({}))) as { kept?: boolean }
    if (body.kept) return false
  }
  if (previewMode() === 'relay') {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('preview_relay_close', { previewId: id }))
      .catch(() => {})
  }
  return true
}

/** A page the agent opened and still uses, on one of the server's listeners. */
export interface AgentPage {
  previewId: string
  workspace: string
  target: PreviewTarget
}

function isPreviewTarget(v: unknown): v is PreviewTarget {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (t.kind === 'url' && typeof t.url === 'string') || (t.kind === 'file' && typeof t.path === 'string')
}

/**
 * The pages the agent wants loaded, whatever session opened them: the
 * server lists them, so a window keeps them driveable while no Preview tab
 * shows them and the session is not on screen.
 */
export async function listAgentPages(): Promise<AgentPage[]> {
  const res = await fetch(`${apiBaseUrl()}/preview`)
  if (!res.ok) await parseDetailOrThrow(res, 'listAgentPages')
  const body = (await res.json()) as { previews?: unknown }
  if (!Array.isArray(body.previews)) return []
  const pages: AgentPage[] = []
  for (const p of body.previews as Partial<PreviewInfo>[]) {
    if (typeof p.id === 'string' && typeof p.workspace === 'string' && isPreviewTarget(p.agent_page)) {
      pages.push({ previewId: p.id, workspace: p.workspace, target: p.agent_page })
    }
  }
  return pages
}

// ── Sites ────────────────────────────────────────────────────────────────
// A page on another machine has no listener: the desktop app shows it in a
// native view (`lib/browser-view.ts`) and carries the agent's commands and
// the page's answers between that view and the server through these calls.

/** Start (or reuse) the server's record of the site page `url` in `workspace`. */
export async function openSitePage(workspace: string, url: string): Promise<PreviewInfo> {
  const res = await fetch(`${apiBaseUrl()}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, url }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'openSitePage')
  return (await res.json()) as PreviewInfo
}

/** The agent's command for a site's page: `{ id, command }`, as the page script takes it. */
export interface SiteCommand {
  id: string
  command: Record<string, unknown>
}

/** The server no longer has this preview (closed for being idle, or restarted). */
export class PreviewGoneError extends Error {}

/**
 * Wait for the agent's next command for site preview `id`. Resolves null
 * when none came in time (ask again), and rejects with `PreviewGoneError`
 * when the server no longer has the preview.
 */
export async function nextSiteCommand(id: string, signal: AbortSignal): Promise<SiteCommand | null> {
  const res = await fetch(`${apiBaseUrl()}/preview/${encodeURIComponent(id)}/agent`, { signal, cache: 'no-store' })
  if (res.status === 204) return null
  if (res.status === 404) throw new PreviewGoneError('Preview not found.')
  if (!res.ok) await parseDetailOrThrow(res, 'nextSiteCommand')
  const body = (await res.json()) as Partial<SiteCommand>
  if (typeof body.id !== 'string' || typeof body.command !== 'object' || body.command === null) return null
  return { id: body.id, command: body.command }
}

/** A command's result: what the page reported, or why the app could not run it. */
export interface SiteReply {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

async function postSite(id: string, part: 'agent' | 'console' | 'page', body: unknown): Promise<void> {
  // Best effort: a preview that is gone has nobody waiting for this.
  await fetch(`${apiBaseUrl()}/preview/${encodeURIComponent(id)}/${part}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

export function sendSiteResult(id: string, reply: SiteReply): Promise<void> {
  return postSite(id, 'agent', reply)
}

export function sendSiteConsole(id: string, entries: unknown[]): Promise<void> {
  return postSite(id, 'console', { entries })
}

/** Tell the server where the site's page is now; it allows the agent's commands by that host. */
export function reportSiteAddress(id: string, url: string): Promise<void> {
  return postSite(id, 'page', { url })
}

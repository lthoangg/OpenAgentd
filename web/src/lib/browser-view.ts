/**
 * Pages of the public web in the Browser tab (desktop app).
 *
 * The desktop shell shows such a page in a native view of its own, placed
 * over the tab's page area (`desktop/src-tauri/src/browser_view.rs`): a real
 * browser engine with its own profile, since a site cannot be framed or
 * proxied the way a local dev server is. This module is the page's side of
 * that: the commands, and the events the view sends back.
 */
import { isLoopbackHost, type PreviewTarget } from '@/api/preview'
import { getPlatform } from '@/hooks/use-platform'

/**
 * Whether this client can show public pages: the desktop app on macOS.
 * Windows and Linux stay off until the view is checked on a real machine.
 */
export function browserViewsAvailable(): boolean {
  const platform = getPlatform()
  return platform.isTauri && platform.os === 'macos'
}

/** The URL of a page on another machine (not a dev server on this one), or null. */
export function publicUrl(raw: string): URL | null {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || isLoopbackHost(host) || host === '0.0.0.0' || host === '[::]' || host.endsWith('.localhost')) return null
    return url
  } catch {
    return null
  }
}

/** Is this tab's page one the native view shows? */
export function isPublicTarget(target: PreviewTarget): target is { kind: 'url'; url: string } {
  return target.kind === 'url' && publicUrl(target.url) !== null
}

/** Where a view sits, as fractions of the window's page (`Frame` in the shell). */
export interface ViewFrame {
  x: number
  y: number
  width: number
  height: number
  /** Scale of the page inside the view; 1 when absent. */
  zoom?: number
}

export type BrowserViewEvent =
  | { id: string; kind: 'load'; phase: 'started' | 'finished'; url: string }
  | { id: string; kind: 'title'; title: string }
  /** A navigation or a new window the view refused. */
  | { id: string; kind: 'blocked'; url: string }
  | { id: string; kind: 'download'; url: string }
  /**
   * Where the view is now: its address changed (a navigation, or the page's
   * own history calls), or it started or stopped loading. `url` is empty when
   * no page could be loaded.
   */
  | { id: string; kind: 'url'; url: string; loading?: boolean }
  /** What the page's script queued (not parsed here), with the address it came from. */
  | { id: string; kind: 'page'; url: string; messages: unknown[] }

export const BROWSER_VIEW_EVENT = 'browser-view'

/**
 * The shell's id for the view of `origin` in `workspace`: letters and digits
 * only, and the same for a tab and for the hidden copy the agent uses.
 */
export function browserViewId(workspace: string, origin: string): string {
  let hash = 5381
  for (const ch of `${workspace}|${origin}`) hash = (Math.imul(hash, 33) ^ ch.charCodeAt(0)) >>> 0
  const host = origin.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)
  return `${host}_${hash.toString(36)}`
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(command, args)
}

// One command at a time: a view is built by its first `open`, and a `close`
// or a second `open` that overtook it would find no view, or build another.
let queue: Promise<unknown> = Promise.resolve()
// This page knows no view yet: ones a page before it (a reload) left are closed first.
let fresh = true

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    if (fresh) {
      fresh = false
      await invoke('browser_view_reset').catch(() => {})
    }
    return run()
  })
  queue = next.catch(() => {})
  return next
}

/** Show `url` in view `id`, creating it on first use; no `frame` loads it out of sight. */
export function openBrowserView(id: string, url: string, frame: ViewFrame | null): Promise<void> {
  return enqueue(() => invoke('browser_view_open', { id, url, frame }))
}

/** Move the view, or hide it with no `frame`. */
export function setBrowserViewFrame(id: string, frame: ViewFrame | null): Promise<void> {
  return enqueue(() => invoke('browser_view_frame', { id, frame }))
}

export function browserViewGo(id: string, to: 'back' | 'forward' | 'reload'): Promise<void> {
  return enqueue(() => invoke('browser_view_go', { id, to }))
}

export function closeBrowserView(id: string): Promise<void> {
  return enqueue(() => invoke('browser_view_close', { id }))
}

/**
 * Run the agent's command `{ id, command }` in the view's page. Rejects with
 * the reason when the page is on another site than the command names, or did
 * not load its script; the result itself arrives later as a `page` event.
 * Not queued behind the other commands: it waits for the page to load.
 */
export function runInBrowserView(id: string, envelope: { id: string; command: Record<string, unknown> }): Promise<void> {
  return invoke('browser_view_run', { id, envelope })
}

/** A dock command for the page's script (comment mode, pins). */
export function dockBrowserView(id: string, command: Record<string, unknown>): Promise<void> {
  return enqueue(() => invoke('browser_view_dock', { id, command }))
}

/** What an import kept. Counts only: the shell never hands a cookie back. */
export interface CookieImportReport {
  site: string
  imported: number
  /** Cookies of other sites in the export, which were left out. */
  other_sites: number
  /** Entries that were not cookies. */
  unreadable: number
}

/**
 * Put the cookies in the pasted export `text` that belong to the view's site
 * into the profile, then load the page again. Rejects with the reason.
 */
export function importBrowserCookies(id: string, text: string): Promise<CookieImportReport> {
  return enqueue(() => invoke<CookieImportReport>('browser_view_import_cookies', { id, text }))
}

/** Delete the cookies of the view's site (signing out of it); resolves how many there were. */
export function clearBrowserViewCookies(id: string): Promise<number> {
  return enqueue(() => invoke<number>('browser_view_clear_cookies', { id }))
}

/** Delete everything the profile holds: every site is signed out. */
export function clearBrowserProfile(): Promise<void> {
  return enqueue(() => invoke('browser_profile_clear'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an event payload; the shell wrote it, but a page chose the URLs and titles in it. */
export function parseBrowserViewEvent(payload: unknown): BrowserViewEvent | null {
  if (!isRecord(payload) || typeof payload.id !== 'string') return null
  const id = payload.id
  const url = typeof payload.url === 'string' ? payload.url.slice(0, 4096) : ''
  switch (payload.kind) {
    case 'load':
      return payload.phase === 'started' || payload.phase === 'finished' ? { id, kind: 'load', phase: payload.phase, url } : null
    case 'title':
      return typeof payload.title === 'string' ? { id, kind: 'title', title: payload.title.slice(0, 300) } : null
    case 'blocked':
      return { id, kind: 'blocked', url }
    case 'download':
      return { id, kind: 'download', url }
    case 'url':
      return typeof payload.loading === 'boolean' ? { id, kind: 'url', url, loading: payload.loading } : { id, kind: 'url', url }
    case 'page':
      return Array.isArray(payload.messages) ? { id, kind: 'page', url, messages: payload.messages } : null
    default:
      return null
  }
}

/** Hear view `id`'s events; returns the function that stops listening. */
export function onBrowserViewEvent(id: string, handler: (event: BrowserViewEvent) => void): () => void {
  let stop: (() => void) | null = null
  let stopped = false
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen(BROWSER_VIEW_EVENT, (event) => {
      const parsed = parseBrowserViewEvent(event.payload)
      if (parsed && parsed.id === id) handler(parsed)
    }))
    .then((unlisten) => {
      if (stopped) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  return () => {
    stopped = true
    stop?.()
  }
}

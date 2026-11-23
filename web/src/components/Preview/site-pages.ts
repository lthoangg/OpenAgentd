/**
 * Site pages: pages of the public web that the desktop shell shows in a
 * native view (`lib/browser-view.ts`).
 *
 * One `SitePage` per workspace and site, shared by whatever shows or needs
 * it in this window: the Browser tab, and the hidden copy that keeps a page
 * the agent uses loaded while no tab shows it. It owns the view, and is the
 * link between that view and the server, doing for a site what a framed
 * local page does for itself:
 *
 * - it waits for the agent's commands (`nextSiteCommand`), hands each to the
 *   view, and returns the page's answer;
 * - it passes the page's console output on;
 * - it tells the server where the page is, which is how the server knows
 *   which site a command needs the user's say for.
 *
 * None of that runs on a timer, so it keeps working while the window is
 * hidden and the engine slows timers down. Everything read from a page is
 * data a site chose.
 */
import { useSyncExternalStore } from 'react'
import {
  PreviewGoneError,
  type SiteCommand,
  closePreview,
  nextSiteCommand,
  openSitePage,
  reportSiteAddress,
  sendSiteConsole,
  sendSiteResult,
} from '@/api/preview'
import {
  type BrowserViewEvent,
  type ViewFrame,
  browserViewGo,
  browserViewId,
  closeBrowserView,
  dockBrowserView,
  onBrowserViewEvent,
  openBrowserView,
  publicUrl,
  runInBrowserView,
  setBrowserViewFrame,
} from '@/lib/browser-view'
import { type DockCommand, type PageMessage, type PreviewConsoleEntry, PREVIEW_NS, PREVIEW_VERSION, parsePageData } from './preview-protocol'

const MAX_CONSOLE_ENTRIES = 300
/** How long the toolbar shows the agent's activity after its last command. */
const AGENT_ACTIVITY_MS = 4000
/** After a failed request for commands, how long before the next. */
const RETRY_MS = 2000
/**
 * How long a page nobody holds stays loaded (out of sight) before its view
 * closes: a tab that closes hands a page the agent still uses to the hidden
 * copy, which mounts a moment later.
 */
export const RELEASE_GRACE_MS = 3000
/**
 * The agent's open of an address reaches a page twice: from the server
 * (`goto`), and from the chat that shows the call. The second one within
 * this long is the same request, not a reload.
 */
const REPEAT_OPEN_MS = 2000
/** The server's command that sends a loaded page to another address of its site. */
const GOTO_ACTION = 'goto'

export interface SitePageState {
  /** Where the page is. */
  url: string
  title: string
  loading: boolean
  /** The page's script answered: comments and the agent's actions work. */
  ready: boolean
  /** The view could not be opened or moved. */
  error: string | null
  /** Something the page tried that Preview does not do (a download, a refused address). */
  notice: string | null
  /** The agent's latest command in this page, shown briefly. */
  agentAction: string | null
  console: PreviewConsoleEntry[]
  /** The server's record of this page, once it has one. */
  previewId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sameFrame(a: ViewFrame | null, b: ViewFrame | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && (a.zoom ?? 1) === (b.zoom ?? 1)
}

/** A command the view was given and has not answered. */
interface Pending {
  /** The page took it: only then can a navigation be its outcome. */
  accepted: boolean
  /** A navigation started after the page took it. */
  navigating: boolean
}

export class SitePage {
  readonly workspace: string
  readonly origin: string
  readonly viewId: string
  private state: SitePageState
  private readonly listeners = new Set<() => void>()
  private readonly messageListeners = new Set<(message: PageMessage) => void>()
  private holders = 0
  private running: AbortController | null = null
  private stopEvents: (() => void) | null = null
  private releaseTimer: number | null = null
  private agentTimer: number | null = null
  /** The native view exists. */
  private opened = false
  private frame: ViewFrame | null = null
  private readonly pending = new Map<string, Pending>()
  private reportedUrl = ''
  private doc: string | null = null
  private lastOpen: { url: string; at: number } | null = null
  /** The address `open` sent the view to, until the view answers: a page, a download, a refusal. */
  private opening: string | null = null
  /** How many such answers there have been. */
  private answers = 0

  constructor(workspace: string, origin: string, startUrl: string) {
    this.workspace = workspace
    this.origin = origin
    this.viewId = browserViewId(workspace, origin)
    this.state = { url: startUrl, title: '', loading: false, ready: false, error: null, notice: null, agentAction: null, console: [], previewId: null }
  }

  getState = (): SitePageState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Hear what the page's script says beyond the state above (a picked element, a shortcut). */
  onMessage(listener: (message: PageMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  private set(patch: Partial<SitePageState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * Keep the page alive until the returned function is called. The first
   * holder starts the link to the server; some time after the last one
   * lets go, the view closes.
   */
  retain(): () => void {
    this.holders += 1
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
    if (!this.running) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holders -= 1
      if (this.holders > 0) return
      // Out of sight at once; closed if nobody takes it over.
      this.place(null)
      this.releaseTimer = window.setTimeout(() => this.stop(), RELEASE_GRACE_MS)
    }
  }

  private start(): void {
    this.running = new AbortController()
    this.stopEvents = onBrowserViewEvent(this.viewId, (event) => this.onEvent(event))
    void this.serve(this.running.signal)
  }

  private stop(): void {
    this.releaseTimer = null
    this.running?.abort()
    this.running = null
    this.stopEvents?.()
    this.stopEvents = null
    if (this.agentTimer !== null) window.clearTimeout(this.agentTimer)
    this.agentTimer = null
    if (this.opened) void closeBrowserView(this.viewId).catch(() => {})
    this.opened = false
    this.pending.clear()
    // The server keeps a page the agent still uses; the hidden copy loads it again.
    const previewId = this.state.previewId
    if (previewId) void closePreview(previewId, { keepAgentPage: true }).catch(() => {})
    this.doc = null
    this.set({ previewId: null, loading: false, ready: false, agentAction: null })
  }

  /** Show `url`, creating the view on first use. With no `frame` it loads out of sight. */
  async open(url: string, frame: ViewFrame | null): Promise<void> {
    const last = this.lastOpen
    if (this.opened && last && last.url === url && Date.now() - last.at < REPEAT_OPEN_MS) {
      this.place(frame)
      return
    }
    this.lastOpen = { url, at: Date.now() }
    this.frame = frame
    this.opening = null
    const answers = this.answers
    this.set({ url, loading: true, error: null, notice: null })
    try {
      await openBrowserView(this.viewId, url, frame)
      this.opened = true
      // Only now: what the view said before it was sent was about the page before.
      if (this.answers === answers) this.opening = url
    } catch (err) {
      this.set({ loading: false, error: reason(err) })
    }
  }

  /** Like `open`, but a page that is already loaded stays as it is and is only placed. */
  async ensure(url: string, frame: ViewFrame | null): Promise<void> {
    if (this.opened) this.place(frame)
    else await this.open(url, frame)
  }

  /** Move the view, or hide it with no `frame`. */
  place(frame: ViewFrame | null): void {
    if (sameFrame(frame, this.frame)) return
    this.frame = frame
    if (this.opened) void setBrowserViewFrame(this.viewId, frame).catch(() => {})
  }

  go(to: 'back' | 'forward' | 'reload'): void {
    if (!this.opened) return
    void browserViewGo(this.viewId, to).catch((err: unknown) => this.set({ error: reason(err) }))
  }

  /** A dock command for the page's script (comment mode, pins). */
  dock(command: DockCommand): void {
    if (!this.opened) return
    void dockBrowserView(this.viewId, { ...command, ns: PREVIEW_NS, v: PREVIEW_VERSION }).catch(() => {})
  }

  clearConsole(): void {
    this.set({ console: [] })
  }

  // ── The link to the server ───────────────────────────────────────────────

  /** Take the agent's commands for this page, one request after another, until stopped. */
  private async serve(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        let previewId = this.state.previewId
        if (!previewId) {
          previewId = (await openSitePage(this.workspace, this.state.url || this.origin)).id
          if (signal.aborted) return
          this.set({ previewId })
          this.reportedUrl = ''
          this.report(this.state.url)
        }
        const command = await nextSiteCommand(previewId, signal)
        if (signal.aborted) return
        if (command) this.run(previewId, command)
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof PreviewGoneError) {
          this.set({ previewId: null })
          continue
        }
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, RETRY_MS)
          signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve() }, { once: true })
        })
      }
    }
  }

  private run(previewId: string, command: SiteCommand): void {
    if (command.command.action === GOTO_ACTION) {
      void this.goto(previewId, command)
      return
    }
    const state: Pending = { accepted: false, navigating: false }
    this.pending.set(command.id, state)
    runInBrowserView(this.viewId, command).then(
      () => { state.accepted = true },
      (err: unknown) => {
        // The view refused it (the page is on another site, or never loaded).
        if (this.pending.delete(command.id)) void sendSiteResult(previewId, { id: command.id, ok: false, error: reason(err) })
      },
    )
  }

  /** The agent opened another address of this site: go there, where the page is shown now. */
  private async goto(previewId: string, command: SiteCommand): Promise<void> {
    const raw = command.command.url
    const next = typeof raw === 'string' ? publicUrl(raw) : null
    if (!next || next.origin !== this.origin) {
      void sendSiteResult(previewId, { id: command.id, ok: false, error: 'That address is not a page of this site.' })
      return
    }
    await this.open(next.href, this.frame)
    const error = this.state.error
    void sendSiteResult(previewId, error ? { id: command.id, ok: false, error } : { id: command.id, ok: true, result: { text: 'Going there.' } })
  }

  /** Tell the server where the page is, once per address. */
  private report(url: string): void {
    const previewId = this.state.previewId
    if (!previewId || !url || url === this.reportedUrl || !publicUrl(url)) return
    this.reportedUrl = url
    void reportSiteAddress(previewId, url)
  }

  private noteUrl(url: string): void {
    if (!url) return
    if (url !== this.state.url) this.set({ url })
    this.report(url)
  }

  private answered(): void {
    this.answers += 1
    this.opening = null
  }

  /** The view says where it is. When it is at rest, a page `open` asked for and never got did not load. */
  private onAddress(url: string, loading: boolean | undefined): void {
    this.noteUrl(url)
    if (loading === undefined) return
    if (loading) {
      this.set({ loading: true })
      return
    }
    const wanted = this.opening
    this.opening = null
    if (wanted !== null || !url) {
      const host = publicUrl(wanted ?? this.state.url)?.hostname ?? 'This page'
      this.set({ loading: false, error: `${host} could not be loaded. Check the address and your connection.` })
    } else this.set({ loading: false })
  }

  private onEvent(event: BrowserViewEvent): void {
    switch (event.kind) {
      case 'load':
        this.noteUrl(event.url)
        if (event.phase === 'started') {
          this.answered()
          this.set({ loading: true, ready: false, error: null, notice: null })
          for (const pending of this.pending.values()) if (pending.accepted) pending.navigating = true
        } else {
          this.set({ loading: false })
          // A command whose page left before it could answer: the navigation is the answer.
          const previewId = this.state.previewId
          for (const [id, pending] of this.pending) {
            if (!pending.navigating) continue
            this.pending.delete(id)
            if (previewId) void sendSiteResult(previewId, { id, ok: true, result: { text: `Done. The page went to ${event.url}.` } })
          }
        }
        break
      case 'url':
        this.onAddress(event.url, event.loading)
        break
      case 'title':
        this.set({ title: event.title })
        break
      case 'blocked':
        this.answered()
        this.set({ notice: `This page tried to open ${event.url.slice(0, 120)}, which the Browser tab does not open.` })
        break
      case 'download':
        this.answered()
        this.set({ loading: false, notice: 'Downloads are not available in the Browser tab yet. Use Open in your browser to download this file.' })
        break
      case 'page':
        this.noteUrl(event.url)
        for (const data of event.messages) this.onPageData(data)
        break
    }
  }

  private onPageData(data: unknown): void {
    if (isRecord(data) && data.ns === PREVIEW_NS && data.type === 'agent-reply') {
      const reply = data.reply
      if (!isRecord(reply) || typeof reply.id !== 'string' || !this.pending.delete(reply.id)) return
      const previewId = this.state.previewId
      if (!previewId) return
      void sendSiteResult(previewId, {
        id: reply.id,
        ok: reply.ok === true,
        result: reply.result,
        error: typeof reply.error === 'string' ? reply.error : undefined,
      })
      return
    }
    const message = parsePageData(data)
    if (!message) return
    switch (message.type) {
      case 'ready':
        if (message.doc && message.doc !== this.doc) {
          // A new page, as in a browser's console without "Preserve log".
          const fresh = this.doc !== null
          this.doc = message.doc
          this.set(fresh ? { ready: true, console: [] } : { ready: true })
        } else this.set({ ready: true })
        break
      case 'leaving':
        // The view itself says when it is loading.
        break
      case 'console': {
        this.set({ console: [...this.state.console, ...message.entries].slice(-MAX_CONSOLE_ENTRIES) })
        const previewId = this.state.previewId
        if (previewId && message.entries.length) void sendSiteConsole(previewId, message.entries)
        break
      }
      case 'agent':
        this.set({ agentAction: message.action })
        if (this.agentTimer !== null) window.clearTimeout(this.agentTimer)
        this.agentTimer = window.setTimeout(() => {
          this.agentTimer = null
          this.set({ agentAction: null })
        }, AGENT_ACTIVITY_MS)
        break
      case 'location':
      case 'relay-error':
        // The address comes from the view itself; a site has no relay.
        break
      case 'select':
      case 'mode':
      case 'shortcut':
        break
    }
    for (const listener of this.messageListeners) listener(message)
  }
}

const pages = new Map<string, SitePage>()

/** The page of `url`'s site in `workspace` (one per site), or null when `url` is not a public page. */
export function sitePage(workspace: string, url: string): SitePage | null {
  const parsed = publicUrl(url)
  if (!parsed) return null
  const id = browserViewId(workspace, parsed.origin)
  const existing = pages.get(id)
  if (existing) return existing
  // Kept for the life of the window: a page nobody holds has no view and no requests.
  const page = new SitePage(workspace, parsed.origin, parsed.href)
  pages.set(id, page)
  return page
}

export function useSitePageState(page: SitePage): SitePageState {
  return useSyncExternalStore(page.subscribe, page.getState, page.getState)
}

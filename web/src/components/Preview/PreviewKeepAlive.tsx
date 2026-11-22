/**
 * PreviewKeepAlive — frames the agent's preview pages out of sight.
 *
 * The `preview` tool drives a page through its injected script, which runs
 * only while the page is framed directly in the app. With the Preview tab
 * closed (or never opened, `previewOpen: 'click'`) nothing frames it and
 * every page action fails. This component, mounted once at the app root,
 * keeps one hidden frame for each page the agent opened that no
 * `PreviewTabView` shows. Opening the tab unmounts the hidden copy, so only
 * one page polls a listener.
 *
 * The frame is laid out for real at full size, transparent, with a single
 * pixel column left on screen: the script skips hidden elements
 * (`display:none`, `visibility:hidden`) and reads a viewport size, and
 * WebKit (the desktop app) throttles the timers of a frame wholly outside
 * the viewport about 40×, which made every action crawl. It needs no
 * messages from the app: it polls its listener on its own, and the messages
 * it sends to the app go unanswered and unread.
 *
 * An agent `fill` focuses a field in the page, which would move the user's
 * keyboard focus into an invisible frame mid-typing; focus that lands on a
 * hidden frame goes straight back to where it was.
 *
 * Which pages: the ones the server lists as the agent's (`listAgentPages`,
 * re-read on `preview_agent_pages` and every minute), so a page stays
 * driveable while its session is not on screen, plus the ones this window
 * saw the agent open. With several windows, only the one holding a Web Lock
 * frames them, so one page polls a listener.
 *
 * A page of the public web is not framed at all: the desktop shell shows it
 * in a native view, and the hidden copy here only holds that page
 * (`site-pages.ts`), which keeps its view loaded out of sight.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { apiBaseUrl } from '@/api/base-url'
import { listAgentPages, openPreview, previewMode } from '@/api/preview'
import { useIsMobile } from '@/hooks/use-mobile'
import { browserViewsAvailable, isPublicTarget } from '@/lib/browser-view'
import {
  type AgentPreview,
  isShownInTab,
  usePreviewKeepAliveStore,
} from '@/stores/usePreviewKeepAliveStore'
import { sitePage } from './site-pages'

/** How often unused previews are dropped. */
const EXPIRE_CHECK_MS = 30_000
/** How often a hidden page's listener is ensured (it may have been closed or moved). */
const REENSURE_MS = 60_000
/** A tab that unmounts is often closing; give its listener's close time to drop the entry. */
const START_DELAY_MS = 1500
/** How often the server's agent pages are re-read (they expire there too). */
const SERVER_PAGES_MS = 60_000

const HIDDEN_FRAME_STYLE = {
  position: 'fixed',
  left: -1279,
  top: 0,
  width: 1280,
  height: 800,
  border: 0,
  opacity: 0,
  pointerEvents: 'none',
} as const

const HIDDEN_FRAME_SELECTOR = 'iframe[data-preview-keep-alive]'

/** Keeps the store's agent pages in step with the server's list while `active`. */
function useServerAgentPages(active: boolean) {
  const version = usePreviewKeepAliveStore((s) => s.serverPagesVersion)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const sync = () =>
      void listAgentPages()
        .then((pages) => {
          if (!cancelled) usePreviewKeepAliveStore.getState().adoptServerPages(pages)
        })
        .catch(() => {})
    sync()
    const timer = window.setInterval(sync, SERVER_PAGES_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, version])
}

/**
 * True in the one window (per server) that frames hidden pages: it holds a
 * Web Lock until it closes, and a waiting window takes over then. Without
 * Web Locks every window frames them, as before.
 */
function useKeepAliveLock(active: boolean): boolean {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const [held, setHeld] = useState(!locks)
  useEffect(() => {
    if (!active || !locks) return
    const controller = new AbortController()
    let release: (() => void) | undefined
    locks
      .request(`oa-preview-keep-alive:${apiBaseUrl()}`, { signal: controller.signal }, () => {
        setHeld(true)
        return new Promise<void>((resolve) => {
          release = resolve
        })
      })
      .catch(() => {})
    return () => {
      controller.abort()
      release?.()
      setHeld(false)
    }
  }, [active, locks])
  return held
}

/** Keeps keyboard focus out of the hidden frames: it returns to the last element the user had. */
function useFocusGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    let last: HTMLElement | null = document.activeElement instanceof HTMLElement && !document.activeElement.matches(HIDDEN_FRAME_SELECTOR) ? document.activeElement : null
    const restore = () => {
      const current = document.activeElement
      if (!(current instanceof HTMLElement) || !current.matches(HIDDEN_FRAME_SELECTOR)) return
      if (last?.isConnected) last.focus({ preventScroll: true })
      else current.blur()
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && target.matches(HIDDEN_FRAME_SELECTOR)) restore()
      else if (target instanceof HTMLElement) last = target
    }
    // Focus moving into a frame's document blurs the window; the frame
    // element is `activeElement` only after that event, hence the delay.
    const onWindowBlur = () => window.setTimeout(restore, 0)
    document.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [active])
}

function HiddenPreviewFrame({ entry }: { entry: AgentPreview }) {
  const { key, workspace, target } = entry
  const [src, setSrc] = useState<string | null>(null)
  // A new agent open of the same listener keeps the frame; the effect reads the latest target.
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let first = true
    let origin: string | null = null
    const store = usePreviewKeepAliveStore.getState
    const ensure = async () => {
      try {
        const info = await openPreview(workspace, targetRef.current)
        if (cancelled) return
        store().setAgentPreviewId(key, info.id)
        if (info.origin !== origin) {
          origin = info.origin
          setSrc(`${info.origin}${info.path}`)
        }
      } catch {
        // The page cannot be shown (file gone, listener refused): stop keeping it.
        if (!cancelled && first) store().forgetKey(key)
      }
      first = false
      if (!cancelled) timer = window.setTimeout(() => void ensure(), REENSURE_MS)
    }
    timer = window.setTimeout(() => void ensure(), START_DELAY_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [key, workspace])

  if (!src) return null
  return (
    <iframe
      title={`Background preview of ${target.kind === 'url' ? target.url : target.path}`}
      src={src}
      aria-hidden="true"
      tabIndex={-1}
      // Same sandbox as the Preview tab: the page's own origin, no top navigation.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      data-preview-keep-alive={key}
      style={HIDDEN_FRAME_STYLE}
    />
  )
}

/** Holds the agent's site page, so its native view stays loaded with no tab showing it. */
function HiddenSitePage({ entry }: { entry: AgentPreview }) {
  const { key, workspace, target } = entry
  const url = target.kind === 'url' ? target.url : ''
  const page = sitePage(workspace, url)
  useEffect(() => page?.retain(), [page])
  // The first time, a page that is already loaded (a tab just closed) stays
  // as it is; a new agent open goes to its address.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (!page) return
    if (loadedRef.current) void page.open(url, null)
    else void page.ensure(url, null)
    loadedRef.current = true
  }, [page, url])
  const previewId = useSyncExternalStore(page?.subscribe ?? noSubscription, () => page?.getState().previewId ?? null)
  useEffect(() => {
    if (previewId) usePreviewKeepAliveStore.getState().setAgentPreviewId(key, previewId)
  }, [key, previewId])
  return null
}

function noSubscription(): () => void {
  return () => {}
}

export function PreviewKeepAlive() {
  const phone = useIsMobile()
  const sites = !phone && browserViewsAvailable()
  const usable = !phone && previewMode() !== 'unavailable'
  const agent = usePreviewKeepAliveStore((s) => s.agent)
  const tabs = usePreviewKeepAliveStore((s) => s.tabs)
  const hasEntries = Object.keys(agent).length > 0
  const holder = useKeepAliveLock(usable || sites)
  useServerAgentPages((usable || sites) && holder)

  useEffect(() => {
    if (!hasEntries) return
    const timer = window.setInterval(() => usePreviewKeepAliveStore.getState().expire(), EXPIRE_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [hasEntries])

  // A site needs the desktop app's native view; a local page needs a reachable listener.
  const hidden = holder ? Object.values(agent).filter((entry) => (isPublicTarget(entry.target) ? sites : usable) && !isShownInTab(tabs, entry)) : []
  useFocusGuard(hidden.some((entry) => !isPublicTarget(entry.target)))
  if (hidden.length === 0) return null
  return (
    <>
      {hidden.map((entry) => (isPublicTarget(entry.target) ? <HiddenSitePage key={entry.key} entry={entry} /> : <HiddenPreviewFrame key={entry.key} entry={entry} />))}
    </>
  )
}

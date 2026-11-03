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
 */
import { useEffect, useRef, useState } from 'react'
import { openPreview, previewMode } from '@/api/preview'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  type AgentPreview,
  isShownInTab,
  usePreviewKeepAliveStore,
} from '@/stores/usePreviewKeepAliveStore'

/** How often unused previews are dropped. */
const EXPIRE_CHECK_MS = 30_000
/** How often a hidden page's listener is ensured (it may have been closed or moved). */
const REENSURE_MS = 60_000
/** A tab that unmounts is often closing; give its listener's close time to drop the entry. */
const START_DELAY_MS = 1500

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

export function PreviewKeepAlive() {
  const phone = useIsMobile()
  const usable = !phone && previewMode() !== 'unavailable'
  const agent = usePreviewKeepAliveStore((s) => s.agent)
  const tabs = usePreviewKeepAliveStore((s) => s.tabs)
  const hasEntries = Object.keys(agent).length > 0

  useEffect(() => {
    if (!hasEntries) return
    const timer = window.setInterval(() => usePreviewKeepAliveStore.getState().expire(), EXPIRE_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [hasEntries])

  const hidden = usable ? Object.values(agent).filter((entry) => !isShownInTab(tabs, entry)) : []
  useFocusGuard(hidden.length > 0)
  if (hidden.length === 0) return null
  return (
    <>
      {hidden.map((entry) => (
        <HiddenPreviewFrame key={entry.key} entry={entry} />
      ))}
    </>
  )
}

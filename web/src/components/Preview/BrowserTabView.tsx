/**
 * BrowserTabView — a Browser tab that shows a page of the public web.
 *
 * The page is not in this document: the desktop shell draws it in a native
 * view placed over this tab's page area (`lib/browser-view.ts`), with a
 * browser profile of its own. This component owns the bar above it, tells
 * the shell where the page area is, and hides the view while anything of
 * the app overlaps it (a menu, a dialog, a tooltip), since the app cannot
 * draw on top of a native view. The page itself, and its link to the agent,
 * is a `SitePage` (`site-pages.ts`), which outlives the tab while the agent
 * still uses the page.
 *
 * The bar is the local preview's, with the site's own controls added
 * (`SiteTools.tsx`). A device size places the view in a box of that size,
 * scaled down when the tab is smaller; **Comment** picks elements as on a
 * local page, with the composer in the tab's flow instead of over the page.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, MousePointerClick, RefreshCw, RotateCw, Smartphone, SquareTerminal } from 'lucide-react'
import { type PreviewTarget, addRecentPreviewUrl, recentPreviewUrls } from '@/api/preview'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { EmptyState } from '@/components/ui/empty-state'
import { usePlatform } from '@/hooks/use-platform'
import { type ViewFrame, browserViewsAvailable, publicUrl } from '@/lib/browser-view'
import type { DesignFeedback } from '@/lib/design-feedback'
import { formatChord } from '@/lib/keyboard/chord'
import { useShortcut } from '@/lib/keyboard/hooks'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { previewListenerKey, usePreviewKeepAliveStore } from '@/stores/usePreviewKeepAliveStore'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'
import { useToastStore } from '@/stores/useToastStore'
import { DEVICE_PRESETS, type DevicePreset, deviceLabel, devicePreset, fitScale, frameCaption, frameSize } from './devices'
import { PreviewAddress } from './PreviewAddress'
import { type PreviewComment, buildDesignFeedback, commentsFromFeedback, feedbackMatchesTarget, restoreComments } from './preview-comments'
import { PreviewCommentComposer, PreviewCommentList } from './PreviewComments'
import { PreviewConsole } from './PreviewConsole'
import type { ElementDescriptor, InspectMode } from './preview-protocol'
import { sitePage, useSitePageState } from './site-pages'
import { SiteAccessPicker, SiteMenu } from './SiteTools'
import { ToolbarButton } from './ToolbarButton'
import { useElementSize } from './use-element-size'

/** How often the page area is measured and checked for something over it. */
const PLACE_INTERVAL_MS = 100
/** Points of the page area tested for an overlapping element, per axis. */
const PROBES = [0.02, 0.25, 0.5, 0.75, 0.98]
/** Room under a framed page for the line that says its size. */
const FRAME_CAPTION_PX = 20
/** How long Undo stays on offer after comments were removed. */
const COMMENT_UNDO_MS = 10_000
/** Alt+C / ⌥C: toggle Comment picking. */
const DESIGN_CHORD = { key: 'C', code: 'KeyC', alt: true } as const

export interface BrowserTabViewProps {
  workspace: string
  tabId: string
  target: { kind: 'url'; url: string }
  /** Grows when the tab is asked to show ``target`` again. */
  navKey: number
  /** Hands the comments to the composer as a design feedback chip. */
  onSendComments?: (feedback: DesignFeedback) => void
  /** An address for another tab was entered: open (or focus) it. */
  onOpenTarget?: (target: PreviewTarget) => void
  /** The tab is the one showing. */
  active?: boolean
  /** Close this tab: Cmd/Ctrl+W pressed while focus was in the page. */
  onRequestClose?: (tabId: string) => void
}

/**
 * Where `stage` is in the window, or null when the page cannot show there:
 * the stage has no size, or something of the app is drawn over it.
 */
export function stageFrame(stage: HTMLElement, viewport: { width: number; height: number }, elementAt: (x: number, y: number) => Element | null): ViewFrame | null {
  const rect = stage.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1 || viewport.width < 1 || viewport.height < 1) return null
  for (const fx of PROBES) {
    for (const fy of PROBES) {
      const hit = elementAt(rect.left + rect.width * fx, rect.top + rect.height * fy)
      // Off-screen points hit nothing; anything else must be the stage itself.
      if (hit && hit !== stage && !stage.contains(hit)) return null
    }
  }
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e5) / 1e5
  return {
    x: round(rect.left / viewport.width),
    y: round(rect.top / viewport.height),
    width: round(rect.width / viewport.width),
    height: round(rect.height / viewport.height),
  }
}

function SiteUnavailable({ url }: { url: string }) {
  return (
    <EmptyState
      icon={Globe}
      title="Public sites open in the desktop app"
      body="On this device, the Browser tab shows local servers and workspace files. Open this page in your browser instead."
      action={<Button type="button" size="sm" variant="default" onClick={() => void openExternalUrl(url)}>Open in your browser</Button>}
    />
  )
}

export function BrowserTabView(props: BrowserTabViewProps) {
  const page = browserViewsAvailable() ? sitePage(props.workspace, props.target.url) : null
  if (!page) return <SiteUnavailable url={publicUrl(props.target.url)?.href ?? props.target.url} />
  return <SiteTab {...props} page={page} />
}

function SiteTab({ workspace, tabId, target, navKey, onSendComments, onOpenTarget, active = true, onRequestClose, page }: BrowserTabViewProps & { page: NonNullable<ReturnType<typeof sitePage>> }) {
  const state = useSitePageState(page)
  const { os } = usePlatform()
  const [addressError, setAddressError] = useState<string | null>(null)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [deviceId, setDeviceId] = useState<DevicePreset['id']>('responsive')
  const [rotated, setRotated] = useState(false)
  const [mode, setMode] = useState<InspectMode>('browse')
  const [comments, setComments] = useState<PreviewComment[]>([])
  const [draft, setDraft] = useState<ElementDescriptor | null>(null)
  const nextCommentRef = useRef(1)
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // The box a device size is shown in; the view covers it instead of the whole stage.
  const frameBoxRef = useRef<HTMLDivElement>(null)
  const stage = useElementSize(stageRef)
  const preset = devicePreset(deviceId)
  const size = frameSize(preset, rotated)
  const scale = fitScale(size, { width: stage.width - 16, height: stage.height - 16 - FRAME_CAPTION_PX })
  const sizedRef = useRef<number | null>(null)
  sizedRef.current = size ? scale : null
  const modeRef = useRef(mode)
  modeRef.current = mode
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const activeRef = useRef(active)
  activeRef.current = active
  const targetUrl = publicUrl(target.url)?.href ?? target.url
  const targetUrlRef = useRef(targetUrl)
  targetUrlRef.current = targetUrl
  const onRequestCloseRef = useRef(onRequestClose)
  onRequestCloseRef.current = onRequestClose

  const measure = useCallback((): ViewFrame | null => {
    const zoom = sizedRef.current
    const area = zoom === null ? stageRef.current : frameBoxRef.current
    if (!area || !activeRef.current) return null
    const frame = stageFrame(area, { width: window.innerWidth, height: window.innerHeight }, (x, y) => document.elementFromPoint(x, y))
    // A device size larger than the tab is drawn smaller, at its own width.
    return frame && zoom !== null && zoom < 1 ? { ...frame, zoom: Math.round(zoom * 1000) / 1000 } : frame
  }, [])

  // Hold the page while the tab is open.
  useEffect(() => page.retain(), [page])

  // Load it; a page already loaded (the agent's hidden copy) is kept as it
  // is. A later request for the same tab goes to its address again.
  const loadedNavKeyRef = useRef<number | null>(null)
  useEffect(() => {
    const again = loadedNavKeyRef.current !== null
    loadedNavKeyRef.current = navKey
    if (again) void page.open(targetUrlRef.current, measure())
    else void page.ensure(targetUrlRef.current, measure())
  }, [page, navKey, measure])

  // Keep the view over the page area, and out of the way of anything drawn over it.
  useEffect(() => {
    const place = () => page.place(measure())
    place()
    const timer = window.setInterval(place, PLACE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [page, measure, active])

  // No hidden copy while this tab shows the page.
  const shownToken = useId()
  const listenerKey = previewListenerKey(workspace, target)
  const previewId = state.previewId ?? undefined
  useEffect(() => {
    usePreviewKeepAliveStore.getState().showTab(shownToken, listenerKey, previewId)
  }, [shownToken, listenerKey, previewId])
  useEffect(() => () => usePreviewKeepAliveStore.getState().hideTab(shownToken), [shownToken])

  // ── Comments ─────────────────────────────────────────────────────────────
  const designDisabled = !state.ready
  const toggleDesign = () => {
    if (designDisabled) return
    setMode((current) => (current === 'inspect' ? 'browse' : 'inspect'))
  }
  const toggleDesignRef = useRef(toggleDesign)
  toggleDesignRef.current = toggleDesign

  useEffect(() => page.onMessage((message) => {
    switch (message.type) {
      case 'ready':
        // A new document knows neither the mode nor the pins.
        page.dock({ type: 'set-mode', mode: modeRef.current })
        page.dock({ type: 'pins', pins: commentsRef.current.map((c) => ({ n: c.n, selector: c.element.selector })) })
        break
      case 'select':
        if (modeRef.current === 'inspect') setDraft(message.element)
        break
      case 'mode':
        setMode(message.mode)
        if (message.mode === 'browse') setDraft(null)
        break
      case 'shortcut':
        if (!activeRef.current) break
        if (message.name === 'close-tab') onRequestCloseRef.current?.(tabId)
        else toggleDesignRef.current()
        break
    }
  }), [page, tabId])

  useEffect(() => {
    page.dock({ type: 'set-mode', mode })
  }, [page, mode])
  useEffect(() => {
    page.dock({ type: 'pins', pins: comments.map((c) => ({ n: c.n, selector: c.element.selector })) })
  }, [page, comments])

  useShortcut(DESIGN_CHORD, () => { toggleDesignRef.current() }, { enabled: active })
  useShortcut({ key: 'Escape' }, () => { setMode('browse') }, { enabled: active && mode === 'inspect' && !draft, within: () => rootRef.current })

  // Feedback taken back out of the composer returns to this tab's list.
  const returned = useReturnedFeedbackStore((s) => s.items)
  const origin = page.origin
  useEffect(() => {
    if (!returned.length) return
    const taken = useReturnedFeedbackStore.getState().take((item) => item.workspace === workspace && feedbackMatchesTarget(item.feedback, { kind: 'url', url: origin }))
    if (!taken.length) return
    const back = taken.flatMap((item) => commentsFromFeedback(item.feedback)).map((c) => {
      const n = nextCommentRef.current++
      return { id: `c${n}`, n, element: c.element, text: c.text }
    })
    setComments((prev) => [...prev, ...back])
  }, [returned, workspace, origin])

  const addComment = (text: string) => {
    if (!draft || !text) return
    const n = nextCommentRef.current++
    setComments((prev) => [...prev, { id: `c${n}`, n, element: draft, text }])
    setDraft(null)
  }
  // Removing comments answers with Undo rather than asking first.
  const offerUndo = (title: string, removed: PreviewComment[]) => {
    useToastStore.getState().push({
      tone: 'info',
      title,
      action: {
        label: 'Undo',
        onAction: () => {
          const next = restoreComments(commentsRef.current, removed)
          nextCommentRef.current = Math.max(...next.map((c) => c.n)) + 1
          setComments(next)
        },
      },
    }, COMMENT_UNDO_MS)
  }
  const removeComment = (id: string) => {
    const removed = comments.find((c) => c.id === id)
    if (!removed) return
    setComments((prev) => prev.filter((c) => c.id !== id))
    offerUndo(`Removed comment ${removed.n}`, [removed])
  }
  const clearComments = () => {
    const removed = comments
    setComments([])
    nextCommentRef.current = 1
    offerUndo(`Cleared ${removed.length} ${removed.length === 1 ? 'comment' : 'comments'}`, removed)
  }
  const sendComments = () => {
    if (!comments.length) return
    onSendComments?.(buildDesignFeedback({ comments, workspace, origin, device: deviceLabel(preset, size, stage) }))
    setComments([])
    nextCommentRef.current = 1
    setMode('browse')
    setDraft(null)
  }

  // An address the page settled on is one to offer again.
  const { url, loading } = state
  useEffect(() => {
    if (!loading && url) addRecentPreviewUrl(workspace, url)
  }, [workspace, url, loading])

  const submitUrl = (raw: string) => {
    setAddressError(null)
    void import('./preview-address').then(({ parseAddress }) => {
      const input = parseAddress(raw, workspace)
      if (!input) return
      switch (input.kind) {
        case 'invalid':
          setAddressError(input.message)
          return
        case 'page':
          // A path on the site the tab is on.
          void page.open(new URL(input.path, url).href, measure())
          return
        case 'site': {
          const next = publicUrl(input.url)
          if (!next) setAddressError(`Invalid URL: ${input.url}`)
          else if (next.origin === page.origin) void page.open(next.href, measure())
          else onOpenTarget?.({ kind: 'url', url: next.href })
          return
        }
        case 'url':
          onOpenTarget?.({ kind: 'url', url: input.url })
          return
        case 'file':
          onOpenTarget?.({ kind: 'file', path: input.path })
      }
    })
  }

  const errorCount = state.console.filter((entry) => entry.level === 'error').length
  const consoleLabel = errorCount ? `Console (${errorCount} errors)` : 'Console'
  const designShortcut = formatChord(DESIGN_CHORD, os)
  const designLabel = designDisabled
    ? state.error ? 'Comment (unavailable on this page)' : 'Comment (the page is still loading)'
    : mode === 'inspect' ? `Stop commenting (Esc or ${designShortcut})` : `Comment on an element (${designShortcut})`
  const host = publicUrl(url)?.hostname.toLowerCase() ?? ''
  const failure = addressError ?? state.error
  const message = failure ?? state.notice
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <div data-preview-toolbar="top" className="@container flex min-h-10 shrink-0 items-center gap-0.5 border-b border-(--color-border-subtle) bg-(--bg-page) px-1 py-1">
        {/* Tooltips go up: one below the bar would be over the page, which hides it. */}
        <ToolbarButton label="Back" tooltipSide="top" onClick={() => page.go('back')}>
          <ArrowLeft size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Forward" tooltipSide="top" onClick={() => page.go('forward')}>
          <ArrowRight size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Refresh" tooltipSide="top" onClick={() => page.go('reload')}>
          <RefreshCw size={14} aria-hidden="true" />
        </ToolbarButton>
        <PreviewAddress
          url={url}
          phone={false}
          loading={loading}
          recent={() => recentPreviewUrls(workspace)}
          files={[]}
          onSubmit={submitUrl}
          onEdit={() => setAddressError(null)}
        />
        {state.agentAction && (
          <span
            role="status"
            title={`The agent is using this page (${state.agentAction})`}
            className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-(--bg-key) px-2 text-meta font-medium text-(--color-text-2)"
          >
            <Bot size={12} aria-hidden="true" />
            <span className="hidden @lg:inline">Agent</span>
            <span className="sr-only">is using this page: {state.agentAction}</span>
          </span>
        )}
        <SiteAccessPicker host={host} refreshKey={state.agentAction} />
        <Dropdown
          aria-label="Device size"
          value={deviceId}
          onValueChange={(value) => setDeviceId(devicePreset(value).id)}
          align="end"
          dense
          className="h-7 shrink-0 gap-1 rounded-xs px-1.5 text-meta"
          trigger={null}
          // The icon always; the size's name once the panel has room for it.
          renderValue={() => (
            <span className="flex items-center gap-1">
              <Smartphone size={12} aria-hidden="true" />
              <span className="hidden @2xl:inline">{preset.label}</span>
            </span>
          )}
        >
          {DEVICE_PRESETS.map((p) => (
            <DropdownItem key={p.id} value={p.id}>
              {p.width ? `${p.label} · ${p.width}×${p.height}` : p.label}
            </DropdownItem>
          ))}
        </Dropdown>
        {size && (
          <ToolbarButton label="Rotate" tooltipSide="top" onClick={() => setRotated((r) => !r)} pressed={rotated}>
            <RotateCw size={14} aria-hidden="true" />
          </ToolbarButton>
        )}
        <ToolbarButton label={consoleLabel} tooltipSide="top" onClick={() => setConsoleOpen((open) => !open)} pressed={consoleOpen}>
          <span className="relative">
            <SquareTerminal size={14} aria-hidden="true" />
            {errorCount > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-3.5 rounded-full bg-(--color-error) px-0.5 text-center text-meta leading-3.5 font-semibold text-(--color-text-on-accent)">
                {errorCount > 99 ? '99+' : errorCount}
              </span>
            )}
          </span>
        </ToolbarButton>
        <ToolbarButton label={designLabel} tooltipSide="top" onClick={toggleDesign} disabled={designDisabled} pressed={mode === 'inspect'}>
          <MousePointerClick size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Open in your browser" tooltipSide="top" onClick={() => void openExternalUrl(url)}>
          <ExternalLink size={14} aria-hidden="true" />
        </ToolbarButton>
        <SiteMenu viewId={page.viewId} host={host} />
      </div>
      {/* While picking, a click no longer follows a link: say so, with the way out. */}
      {mode === 'inspect' && (
        <div role="status" className="flex min-h-8 shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-key) px-3 py-1 text-xs text-(--color-text-2)">
          <MousePointerClick size={14} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
          <p className="min-w-0 flex-1 truncate">Click an element to comment</p>
          <kbd aria-hidden="true" className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-meta text-(--color-text-muted)">Esc</kbd>
          <Button type="button" size="xs" variant="default" className="shrink-0" onClick={() => setMode('browse')}>
            Done
          </Button>
        </div>
      )}
      {/* In the flow, not over the page: nothing of the app can be drawn above the view. */}
      {draft && <PreviewCommentComposer key={draft.selector} element={draft} onAdd={addComment} onCancel={() => setDraft(null)} />}
      {message && (
        <div
          role={failure ? 'alert' : 'status'}
          className={cn(
            'flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-meta',
            failure ? 'border-(--color-error)/25 bg-(--color-error-subtle) text-(--color-error)' : 'border-(--color-border-subtle) bg-(--bg-key) text-(--color-text-muted)',
          )}
        >
          <p className="min-w-0 flex-1 break-words">{message}</p>
        </div>
      )}
      {/* The native view covers this while it shows; what is seen here is the moment it is hidden. */}
      <div ref={stageRef} data-browser-stage={page.viewId} className="min-h-0 flex-1 overflow-hidden bg-(--bg-sidebar)">
        {size && (
          <div className="flex h-full w-full flex-col items-center justify-start overflow-hidden p-2">
            <div
              ref={frameBoxRef}
              className="shrink-0 rounded-sm border border-(--color-border)"
              style={{ width: size.width * scale, height: size.height * scale }}
            />
            <p data-frame-caption="" className="flex shrink-0 items-end font-mono text-meta text-(--color-text-muted)" style={{ height: FRAME_CAPTION_PX }}>
              {frameCaption(size, scale)}
            </p>
          </div>
        )}
      </div>
      {consoleOpen && <PreviewConsole entries={state.console} onClear={() => page.clearConsole()} onClose={() => setConsoleOpen(false)} />}
      {comments.length > 0 && (
        <PreviewCommentList
          comments={comments}
          onRemove={removeComment}
          onEdit={(id, text) => setComments((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)))}
          onClear={clearComments}
          onSend={sendComments}
          onShow={(n) => page.dock({ type: 'show-pin', n })}
        />
      )}
    </div>
  )
}

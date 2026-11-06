/**
 * PreviewTabView — the review dock's built-in web preview.
 *
 * Frames a preview listener (`/api/preview`): a local dev server or a
 * workspace HTML file on its own loopback origin (or, when the backend is on
 * another device, the native relay's loopback origin). The toolbar drives the
 * page through the inspector script (`preview-protocol.ts`); **Comment**
 * turns on the element picker, and picked elements collect numbered
 * comments that **Send to agent** puts into the composer.
 *
 * The tab stays mounted while another dock tab is active, so the page, its
 * state, and pending comments survive switching tabs.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  Globe,
  MoreHorizontal,
  MousePointerClick,
  RefreshCw,
  RotateCw,
  Smartphone,
  SquareTerminal,
} from 'lucide-react'
import { type PreviewInfo, type PreviewTarget, openPreview, previewMode, previewTargetKey } from '@/api/preview'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/use-platform'
import { useIsMobile } from '@/hooks/use-mobile'
import { WORKSPACE_TREE_STALE_MS, workspaceFileListQueryOptions } from '@/queries/workspace-files'
import { DOCK_ACTION_BUTTON_CLASS } from '../WorkspacePanel/dock-tab-styles'
import { DEVICE_PRESETS, type DevicePreset, deviceLabel, devicePreset, fitScale, frameSize } from './devices'
import { type ComposerAnchor, PreviewCommentComposer, PreviewCommentList } from './PreviewComments'
import type { DesignFeedback } from '@/lib/design-feedback'
import { useShortcut } from '@/lib/keyboard/hooks'
import { formatChord } from '@/lib/keyboard/chord'
import { frameKeymap, useFrameKeys } from '@/lib/keyboard/frames'
import { NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD } from '@/lib/app-shortcuts'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'
import { previewListenerKey, usePreviewKeepAliveStore } from '@/stores/usePreviewKeepAliveStore'
import { type PreviewComment, buildDesignFeedback, commentsFromFeedback, feedbackMatchesTarget, resolveSourceFile } from './preview-comments'
import {
  type DockCommand,
  type ElementDescriptor,
  type InspectMode,
  type PreviewConsoleEntry,
  commandMessage,
  parsePageMessage,
} from './preview-protocol'

const MAX_CONSOLE_ENTRIES = 300
/** After ``load``, how long a page may take to report ``ready`` before the tools count as missing. */
const READY_GRACE_MS = 800
/** How long the toolbar shows the agent's activity after its last command. */
const AGENT_ACTIVITY_MS = 4000
/** The loading bar gives up after this: a link that turned into a download never loads. */
const LOADING_CAP_MS = 20_000

export interface PreviewTabViewProps {
  workspace: string
  tabId: string
  target: PreviewTarget
  /** Grows when the tab is asked to show ``target`` again. */
  navKey: number
  /** Tells the dock which preview listener backs this tab. */
  onPreviewId?: (tabId: string, previewId: string) => void
  /** Hands the design comments to the composer as a design feedback chip. */
  onSendComments?: (feedback: DesignFeedback) => void
  /** A URL on another origin was entered: open (or focus) its own tab. */
  onOpenTarget?: (target: PreviewTarget) => void
  /** The tab is the one showing; background tabs ignore shortcuts. */
  active?: boolean
  /** Close this tab: Cmd/Ctrl+W pressed while focus was in the page. */
  onRequestClose?: (tabId: string) => void
}

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const rect = node.getBoundingClientRect()
      setSize((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return size
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  disabledReason,
  pressed,
  children,
  className,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  /** Why it is disabled; the tooltip says this instead of the label while it is. */
  disabledReason?: string
  pressed?: boolean
  children: React.ReactNode
  className?: string
}) {
  const reason = disabled ? disabledReason : undefined
  return (
    <Tooltip>
      {/* The trigger wraps the button in a span, so a disabled one still gets the hover. */}
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-description={reason}
            aria-pressed={pressed}
            className={cn(DOCK_ACTION_BUTTON_CLASS, pressed && 'bg-(--bg-key) text-(--color-text)', className)}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{reason ?? label}</TooltipContent>
    </Tooltip>
  )
}

function originOf(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `http://${url}`).origin
  } catch {
    return null
  }
}

/** Latest mtime of the files next to (and below) a previewed HTML file. */
function siblingsSignature(files: { path: string; mtime: number }[] | undefined, path: string): number | null {
  if (!files) return null
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  let latest = 0
  for (const file of files) {
    if (file.path.startsWith(dir) && file.mtime > latest) latest = file.mtime
  }
  return latest
}

/** Alt+C / ⌥C: toggle Comment picking, whether focus is in the dock or the page. */
const DESIGN_CHORD = { key: 'C', code: 'KeyC', alt: true } as const
/** Chords the page forwards besides the app's own: Comment and ⌃Tab between tabs. */
const PAGE_EXTRA_CHORDS = [DESIGN_CHORD, NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD]

export function PreviewTabView({ workspace, tabId, target, navKey, onPreviewId, onSendComments, onOpenTarget, active = true, onRequestClose }: PreviewTabViewProps) {
  const reach = previewMode()
  const available = reach !== 'unavailable'
  const { os } = usePlatform()
  const phone = useIsMobile()
  const designShortcut = formatChord(DESIGN_CHORD, os)
  const [info, setInfo] = useState<PreviewInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What was typed in the address bar cannot be shown: nothing to retry, editing clears it.
  const [addressError, setAddressError] = useState<string | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [path, setPath] = useState('/')
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [inspectorMissing, setInspectorMissing] = useState(false)
  // The page is the proxy's "Nothing is running" page: the dev server is not up.
  const [pageDown, setPageDown] = useState(false)
  // A page is on its way: the frame was (re)loaded or the page started to leave.
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<InspectMode>('browse')
  const [deviceId, setDeviceId] = useState<DevicePreset['id']>('responsive')
  const [rotated, setRotated] = useState(false)
  const [consoleEntries, setConsoleEntries] = useState<PreviewConsoleEntry[]>([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [comments, setComments] = useState<PreviewComment[]>([])
  const [draft, setDraft] = useState<{ element: ElementDescriptor; anchor: ComposerAnchor } | null>(null)
  // The agent's latest command in this page, shown briefly in the toolbar.
  const [agentAction, setAgentAction] = useState<string | null>(null)
  const agentTimerRef = useRef<number | null>(null)
  // Latest Comment toggle, for the shortcut listeners below.
  const toggleDesignRef = useRef<() => void>(() => {})
  const activeRef = useRef(active)
  activeRef.current = active
  // Workspace-relative file paths, to place React 19 sources (``/src/…``).
  const filePathsRef = useRef<string[]>([])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The document that last reported ``ready``; a new one starts the console afresh.
  const docRef = useRef<string | null>(null)
  const osRef = useRef(os)
  osRef.current = os
  const stageRef = useRef<HTMLDivElement>(null)
  const frameBoxRef = useRef<HTMLDivElement>(null)
  const readyRef = useRef(false)
  // When the page last reported ``ready``, and the timer judging the latest load.
  const lastReadyAtRef = useRef(0)
  const loadTimerRef = useRef<number | null>(null)
  const nextCommentRef = useRef(1)
  const stage = useElementSize(stageRef)

  const preset = devicePreset(deviceId)
  const size = frameSize(preset, rotated)
  const scale = fitScale(size, { width: stage.width - 16, height: stage.height - 16 })
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const modeRef = useRef(mode)
  modeRef.current = mode
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  // Callers pass fresh closures; loading must only follow the target itself.
  const targetRef = useRef(target)
  targetRef.current = target
  const onPreviewIdRef = useRef(onPreviewId)
  onPreviewIdRef.current = onPreviewId
  const onRequestCloseRef = useRef(onRequestClose)
  onRequestCloseRef.current = onRequestClose
  // The origin the frame was last loaded from: a relay that restarted on
  // another port (the app was suspended) needs a fresh load, not a message.
  const frameOriginRef = useRef<string | null>(null)
  const targetKey = `${previewTargetKey(target)}|${target.kind === 'url' ? target.url : target.path}`

  // Tell the keep-alive that this tab shows the preview, so no hidden copy
  // polls the same listener. The listener id sharpens the match once known.
  const shownToken = useId()
  const listenerKey = previewListenerKey(workspace, target)
  const shownId = info?.id
  useEffect(() => {
    if (!available) return
    usePreviewKeepAliveStore.getState().showTab(shownToken, listenerKey, shownId)
  }, [available, shownToken, listenerKey, shownId])
  useEffect(() => () => usePreviewKeepAliveStore.getState().hideTab(shownToken), [shownToken])

  const post = useCallback((command: DockCommand) => {
    if (!info) return
    frameRef.current?.contentWindow?.postMessage(commandMessage(command), info.origin)
  }, [info])

  // Start (or reuse) the listener; a later request for the same tab navigates it.
  const load = useCallback(async (navigate: boolean) => {
    setError(null)
    try {
      const next = await openPreview(workspace, targetRef.current)
      setInfo(next)
      onPreviewIdRef.current?.(tabId, next.id)
      const url = `${next.origin}${next.path}`
      if (navigate && readyRef.current && frameOriginRef.current === next.origin) {
        frameRef.current?.contentWindow?.postMessage(commandMessage({ type: 'navigate', path: next.path }), next.origin)
      } else {
        frameOriginRef.current = next.origin
        setSrc(url)
        setPath(next.path)
        setFrameKey((k) => k + 1)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspace, tabId])

  const loadedNavKeyRef = useRef<number | null>(null)
  useEffect(() => {
    if (!available) return
    const navigate = loadedNavKeyRef.current !== null
    loadedNavKeyRef.current = navKey
    void load(navigate)
    // targetKey: a new target for this tab (read through targetRef) reloads it.
  }, [available, load, navKey, targetKey])

  // ── Page messages ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!info) return
    const origin = info.origin
    const onMessage = (event: MessageEvent) => {
      const message = parsePageMessage(event, origin, frameRef.current?.contentWindow)
      if (!message) return
      switch (message.type) {
        case 'ready': {
          readyRef.current = true
          lastReadyAtRef.current = performance.now()
          setReady(true)
          setInspectorMissing(false)
          setPageDown(message.status === 'down')
          setPath(message.path)
          if (message.doc && message.doc !== docRef.current) {
            // A new page, as in a browser's console without "Preserve log".
            if (docRef.current !== null) setConsoleEntries([])
            docRef.current = message.doc
          }
          const win = frameRef.current?.contentWindow
          win?.postMessage(commandMessage({ type: 'set-mode', mode: modeRef.current }), origin)
          win?.postMessage(commandMessage({ type: 'pins', pins: commentsRef.current.map((c) => ({ n: c.n, selector: c.element.selector })) }), origin)
          win?.postMessage(commandMessage({ type: 'keymap', keymap: frameKeymap(osRef.current, PAGE_EXTRA_CHORDS) }), origin)
          break
        }
        case 'location':
          setPath(message.path)
          break
        case 'leaving':
          setLoading(true)
          break
        case 'select': {
          if (modeRef.current !== 'inspect') break
          const stageBox = stageRef.current?.getBoundingClientRect()
          const frameBox = frameBoxRef.current?.getBoundingClientRect()
          const s = scaleRef.current
          const rect = message.element.rect
          const left = (frameBox?.left ?? 0) - (stageBox?.left ?? 0) + rect.x * s
          const top = (frameBox?.top ?? 0) - (stageBox?.top ?? 0) + (rect.y + rect.height) * s + 6
          const source = message.element.source
          const file = source?.file ? resolveSourceFile(source.file, workspace, filePathsRef.current) : null
          const element = file && source ? { ...message.element, source: { ...source, file } } : message.element
          setDraft({ element, anchor: { top, left } })
          break
        }
        case 'console':
          setConsoleEntries((prev) => [...prev, ...message.entries].slice(-MAX_CONSOLE_ENTRIES))
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
        case 'agent':
          setAgentAction(message.action)
          if (agentTimerRef.current !== null) window.clearTimeout(agentTimerRef.current)
          agentTimerRef.current = window.setTimeout(() => {
            agentTimerRef.current = null
            setAgentAction(null)
          }, AGENT_ACTIVITY_MS)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [info, workspace, tabId])

  useEffect(() => () => {
    if (agentTimerRef.current !== null) window.clearTimeout(agentTimerRef.current)
    if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current)
  }, [])

  // A fresh frame is loading until its ``load``.
  useEffect(() => {
    if (frameKey > 0) setLoading(true)
  }, [frameKey])
  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setLoading(false), LOADING_CAP_MS)
    return () => window.clearTimeout(timer)
  }, [loading])

  // Feedback taken back out of the composer returns to this tab's list.
  const returned = useReturnedFeedbackStore((s) => s.items)
  useEffect(() => {
    if (!returned.length) return
    const taken = useReturnedFeedbackStore.getState().take((item) => item.workspace === workspace && feedbackMatchesTarget(item.feedback, targetRef.current))
    if (!taken.length) return
    const back = taken.flatMap((item) => commentsFromFeedback(item.feedback)).map((c) => {
      const n = nextCommentRef.current++
      return { id: `c${n}`, n, element: c.element, text: c.text }
    })
    setComments((prev) => [...prev, ...back])
  }, [returned, workspace, targetKey])

  // Alt+C toggles picking while this tab shows (not while typing in a field);
  // the page forwards it when focused.
  useShortcut(DESIGN_CHORD, () => { toggleDesignRef.current() }, { enabled: active && available })
  // Esc stops picking from anywhere in this tab (the page handles its own Esc).
  useShortcut({ key: 'Escape' }, () => { setMode('browse') }, { enabled: active && mode === 'inspect' && !draft, within: () => rootRef.current })
  // Keys the page forwards (per the keymap sent on `ready`) replay here.
  useFrameKeys(frameRef, { origin: info?.origin ?? null, enabled: Boolean(info) })

  useEffect(() => {
    post({ type: 'set-mode', mode })
  }, [mode, post])

  useEffect(() => {
    post({ type: 'pins', pins: comments.map((c) => ({ n: c.n, selector: c.element.selector })) })
  }, [comments, post])

  const onFrameLoad = () => {
    const loadedAt = performance.now()
    setLoading(false)
    // A page with the inspector answers ``hello`` with ``ready`` (its first
    // ``ready`` came before ``load``). Only the newest load is judged: an
    // earlier timer must not decide for a page that reloaded meanwhile.
    post({ type: 'hello' })
    if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current)
    loadTimerRef.current = window.setTimeout(() => {
      loadTimerRef.current = null
      if (lastReadyAtRef.current < loadedAt) {
        readyRef.current = false
        setReady(false)
        setInspectorMissing(true)
        // Not the proxy's page (it always has the script): the server is up.
        setPageDown(false)
      }
    }, READY_GRACE_MS)
  }

  // ── Live reload for workspace files ──────────────────────────────────────
  const files = useQuery({
    ...workspaceFileListQueryOptions(workspace),
    // File previews reload on changes; every preview resolves sources with it.
    enabled: available,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  filePathsRef.current = useMemo(() => files.data?.files.map((f) => f.path) ?? [], [files.data?.files])
  const signature = useMemo(
    () => (target.kind === 'file' ? siblingsSignature(files.data?.files, target.path) : null),
    [files.data?.files, target],
  )
  const lastSignatureRef = useRef<number | null>(null)
  useEffect(() => {
    if (signature === null) return
    const previous = lastSignatureRef.current
    lastSignatureRef.current = signature
    if (previous === null || previous === signature) return
    const timer = window.setTimeout(() => {
      if (readyRef.current) post({ type: 'reload' })
      else setFrameKey((k) => k + 1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [signature, post])

  // ── Toolbar actions ──────────────────────────────────────────────────────
  const targetOrigin = target.kind === 'url' ? info?.target ?? originOf(target.url) : null
  const displayUrl = target.kind === 'url' ? `${targetOrigin ?? ''}${path}` : path
  const pageUrl = target.kind === 'url' ? `${targetOrigin ?? ''}${path}` : info ? `${info.origin}${path}` : null

  const navigateTo = (nextPath: string) => {
    if (readyRef.current) post({ type: 'navigate', path: nextPath })
    else if (info) {
      setSrc(`${info.origin}${nextPath}`)
      setFrameKey((k) => k + 1)
    }
  }

  /**
   * A workspace file typed in a dev-server tab opens in its own tab, once
   * the server confirms it is a file. A full path that is not one is still
   * a path on the dev server.
   */
  const openWorkspaceFile = async (path: string, fallback?: string) => {
    const next: PreviewTarget = { kind: 'file', path }
    try {
      await openPreview(workspace, next)
    } catch (err) {
      if (fallback) {
        navigateTo(fallback)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const host = targetOrigin ? targetOrigin.replace(/^[a-z]+:\/\//i, '') : null
      setAddressError(host ? `${message} Start with / for a page on ${host}.` : message)
      return
    }
    setAddressError(null)
    onOpenTarget?.(next)
  }

  const submitUrl = (raw: string) => {
    setUrlDraft(null)
    setAddressError(null)
    void import('./preview-address').then(({ parseAddress }) => {
      const input = parseAddress(raw, workspace)
      if (!input) return
      switch (input.kind) {
      case 'page':
        navigateTo(input.path)
        return
      case 'invalid':
        setAddressError(input.message)
        return
      case 'file':
        // A file tab's server is the workspace: its other files open in place.
        if (target.kind === 'file') navigateTo(`/${input.path}`)
        else void openWorkspaceFile(input.path, input.fallback)
        return
      case 'url':
        try {
          const u = new URL(input.url.includes('://') ? input.url : `http://${input.url}`)
          if (target.kind === 'url' && u.origin === targetOrigin) navigateTo(`${u.pathname}${u.search}${u.hash}`)
          else onOpenTarget?.({ kind: 'url', url: input.url })
        } catch {
          setAddressError(`Invalid URL: ${input.url}`)
        }
      }
    })
  }

  const reload = async () => {
    // Re-ensure first: an idle listener may have been closed.
    try {
      const next = await openPreview(workspace, targetRef.current)
      setInfo(next)
      if (readyRef.current && next.origin === info?.origin) post({ type: 'reload' })
      else {
        frameOriginRef.current = next.origin
        setSrc(`${next.origin}${path}`)
        setFrameKey((k) => k + 1)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const addComment = (text: string) => {
    if (!draft || !text) return
    const n = nextCommentRef.current++
    setComments((prev) => [...prev, { id: `c${n}`, n, element: draft.element, text }])
    setDraft(null)
  }

  const sendComments = () => {
    if (!comments.length) return
    const device = deviceLabel(preset, size, { width: stage.width, height: stage.height })
    onSendComments?.(buildDesignFeedback({
      comments,
      workspace,
      origin: target.kind === 'url' ? targetOrigin : null,
      filePath: target.kind === 'file' ? target.path : null,
      device,
    }))
    setComments([])
    nextCommentRef.current = 1
    setMode('browse')
    setDraft(null)
  }

  const errorCount = consoleEntries.filter((e) => e.level === 'error').length
  const designDisabled = !ready || inspectorMissing || pageDown
  const targetHost = targetOrigin ? targetOrigin.replace(/^[a-z]+:\/\//i, '') : null
  const downTitle = `Nothing is running on ${targetHost ?? 'this address'} yet`
  const consoleLabel = errorCount ? `Console (${errorCount} errors)` : 'Console'
  const designLabel = designDisabled ? 'Comment (unavailable on this page)' : mode === 'inspect' ? `Stop commenting (Esc or ${designShortcut})` : `Comment on an element (${designShortcut})`
  const openLabel = reach === 'relay' ? 'Open in browser (not available from this device)' : 'Open in browser'
  const openDisabled = !pageUrl || reach === 'relay'
  // Back and Forward need the page's own script; say which thing is missing.
  const navReason = (dir: 'back' | 'forward') => pageDown
    ? `Can't go ${dir}: ${downTitle.charAt(0).toLowerCase()}${downTitle.slice(1)}`
    : inspectorMissing
      ? `Can't go ${dir} on this page: it did not load the preview script`
      : `Can't go ${dir} yet: the page is still loading`
  toggleDesignRef.current = () => {
    if (designDisabled) return
    setMode((m) => (m === 'inspect' ? 'browse' : 'inspect'))
  }

  if (!available) {
    return (
      <EmptyState
        icon={Globe}
        title="Preview isn't available in this browser"
        body="The preview runs next to the OpenAgentd server. Open it in the OpenAgentd app, or in a browser on the computer that runs the server."
      />
    )
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {/* 40px (44px on touch): the address field is 32px (36px on touch), taller than the 28px tool buttons. */}
      {/* A phone puts the bar at the bottom, in thumb reach, as Safari does (mockup J7). */}
      <div
        data-preview-toolbar={phone ? 'bottom' : 'top'}
        className={cn(
          'flex min-h-10 shrink-0 items-center gap-0.5 border-(--color-border-subtle) bg-(--bg-page) px-1 py-1',
          // Safari's bottom bar: the address as a full-width pill on top, the
          // tools spread under it in thumb reach.
          phone ? 'order-last flex-wrap justify-between gap-y-1 border-t px-2 pt-2 pb-[max(0.25rem,env(safe-area-inset-bottom))]' : 'border-b',
        )}
      >
        <ToolbarButton label="Back" onClick={() => post({ type: 'history', dir: -1 })} disabled={!ready || pageDown} disabledReason={navReason('back')}>
          <ArrowLeft size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Forward" onClick={() => post({ type: 'history', dir: 1 })} disabled={!ready || pageDown} disabledReason={navReason('forward')}>
          <ArrowRight size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Refresh" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" />
        </ToolbarButton>
        <form
          className={cn('relative min-w-0', phone ? 'order-first basis-full' : 'mx-1 flex-1')}
          onSubmit={(event) => {
            event.preventDefault()
            submitUrl(urlDraft ?? displayUrl)
          }}
        >
          <input
            aria-label="Preview address"
            value={urlDraft ?? displayUrl}
            onChange={(event) => {
              setUrlDraft(event.target.value)
              setAddressError(null)
            }}
            onFocus={(event) => event.target.select()}
            onBlur={() => setUrlDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setUrlDraft(null)
                event.currentTarget.blur()
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            enterKeyHint="go"
            className={cn(
              'w-full min-w-0 border text-(--color-text) outline-none transition-colors',
              phone
                ? 'h-10 rounded-full border-transparent bg-(--bg-key) px-4 text-center text-xs focus:border-(--color-text-subtle) focus:text-left'
                : 'h-8 rounded-xs border-(--color-border) bg-(--bg-input) px-2 font-mono text-xs focus:border-(--color-text-subtle) pointer-coarse:h-9',
            )}
          />
          {loading && !pageDown && (
            // Safari's way: a thin sweep along the field's bottom edge.
            <div role="progressbar" aria-label="Loading page" className={cn('pointer-events-none absolute bottom-px h-0.5 overflow-hidden rounded-full', phone ? 'inset-x-4' : 'inset-x-px')}>
              <div className="oa-loading-bar h-full w-2/5 rounded-full bg-(--color-text-2)/60" />
            </div>
          )}
        </form>
        {agentAction && (
          <span
            role="status"
            title={`The agent is using this page (${agentAction})`}
            className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-(--bg-key) px-2 text-meta font-medium text-(--color-text-2)"
          >
            <Bot size={12} aria-hidden="true" />
            <span className="hidden sm:inline">Agent</span>
            <span className="sr-only">is using this page: {agentAction}</span>
          </span>
        )}
        <Dropdown
          aria-label="Device size"
          value={deviceId}
          onValueChange={(value) => setDeviceId(devicePreset(value).id)}
          align="end"
          dense
          // rounded-xs: the address bar's corners, not the form trigger's rounded-md.
          // dense: 28px on touch too, so it fits the 32px toolbar.
          className="h-7 shrink-0 gap-1 rounded-xs px-1.5 text-meta"
          trigger={
            <span className="flex items-center gap-1">
              <Smartphone size={12} aria-hidden="true" />
              <span className="hidden sm:inline">{preset.label}</span>
            </span>
          }
        >
          {DEVICE_PRESETS.map((p) => (
            <DropdownItem key={p.id} value={p.id}>
              {p.width ? `${p.label} · ${p.width}×${p.height}` : p.label}
            </DropdownItem>
          ))}
        </Dropdown>
        {phone && size && (
          <ToolbarButton label={rotated ? 'Rotate back' : 'Rotate'} onClick={() => setRotated((r) => !r)}>
            <RotateCw size={14} aria-hidden="true" />
          </ToolbarButton>
        )}
        {phone ? (
          // Phones: the rarer tools share one menu, so the address keeps room.
          <Dropdown
            aria-label="More preview actions"
            align="end"
            dense
            trigger={
              <span className="relative flex items-center">
                <MoreHorizontal size={14} aria-hidden="true" />
                {errorCount > 0 && <span className="absolute -top-1 -right-1 size-1.5 rounded-full bg-(--color-error)" aria-hidden="true" />}
              </span>
            }
            className={cn(DOCK_ACTION_BUTTON_CLASS, 'justify-center border-0 bg-transparent p-0 [&>svg]:hidden')}
            panelClassName="w-56"
          >
            {[
              <DropdownItem key="console" onSelect={() => setConsoleOpen((o) => !o)}>{consoleLabel}</DropdownItem>,
              <DropdownItem key="design" disabled={designDisabled} onSelect={() => toggleDesignRef.current()}>
                {mode === 'inspect' ? 'Stop commenting' : designDisabled ? 'Comment (unavailable on this page)' : 'Comment on an element'}
              </DropdownItem>,
              <DropdownItem key="open" disabled={openDisabled} onSelect={() => pageUrl && void openExternalUrl(pageUrl)}>{openLabel}</DropdownItem>,
            ].filter(Boolean)}
          </Dropdown>
        ) : null}
        {!phone && size && (
          <ToolbarButton label="Rotate" onClick={() => setRotated((r) => !r)} pressed={rotated}>
            <RotateCw size={14} aria-hidden="true" />
          </ToolbarButton>
        )}
        {!phone && (
        <ToolbarButton label={consoleLabel} onClick={() => setConsoleOpen((o) => !o)} pressed={consoleOpen}>
          <span className="relative">
            <SquareTerminal size={14} aria-hidden="true" />
            {errorCount > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-3.5 rounded-full bg-(--color-error) px-0.5 text-center text-meta leading-3.5 font-semibold text-(--color-text-on-accent)">
                {errorCount > 99 ? '99+' : errorCount}
              </span>
            )}
          </span>
        </ToolbarButton>
        )}
        {!phone && (
        <ToolbarButton
          label={designLabel}
          onClick={() => toggleDesignRef.current()}
          disabled={designDisabled}
          pressed={mode === 'inspect'}
        >
          <MousePointerClick size={14} aria-hidden="true" />
        </ToolbarButton>
        )}
        {/* A relayed page lives on this app's relay, which another browser cannot use. */}
        {!phone && (
        <ToolbarButton
          label={openLabel}
          onClick={() => pageUrl && void openExternalUrl(pageUrl)}
          disabled={openDisabled}
          disabledReason={reach === 'relay' ? undefined : 'No page loaded yet'}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </ToolbarButton>
        )}
      </div>
      {(error || addressError || inspectorMissing) && (
        <div role={error || addressError ? 'alert' : 'status'} className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-meta', error || addressError ? 'border-(--color-error)/25 bg-(--color-error-subtle) text-(--color-error)' : 'border-(--color-border-subtle) bg-(--bg-key) text-(--color-text-muted)')}>
          <p className="min-w-0 flex-1 break-words">
            {addressError ?? error ?? 'Comment tools and the console are unavailable on this page: it did not load the preview script (a strict Content-Security-Policy can block it).'}
          </p>
          {error && !addressError && (
            <Button type="button" size="xs" variant="subtle" onClick={() => void reload()}>
              Retry
            </Button>
          )}
        </div>
      )}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-(--bg-sidebar)">
        <div className={cn('flex h-full w-full justify-center overflow-hidden', size && 'items-start p-2')}>
          <div
            ref={frameBoxRef}
            // White, a browser's default page, behind pages that set no background.
            className={cn('relative shrink-0 overflow-hidden bg-white', size ? 'rounded-sm border border-(--color-border) shadow-sm' : 'h-full w-full')}
            style={size ? { width: size.width * scale, height: size.height * scale } : undefined}
          >
            {src && (
              <iframe
                key={frameKey}
                ref={frameRef}
                title={`Preview of ${target.kind === 'url' ? target.url : target.path}`}
                src={src}
                onLoad={onFrameLoad}
                // Own origin (allow-same-origin keeps the page's storage);
                // no top navigation, so the page cannot replace the app.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                className="block border-0 bg-white"
                style={size ? { width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: '0 0' } : { width: '100%', height: '100%' }}
              />
            )}
          </div>
        </div>
        {pageDown && (
          // The proxy's own page keeps retrying underneath; this says the same in the app's colours.
          <div className="absolute inset-0 bg-(--bg-sidebar)">
            <EmptyState
              icon={Globe}
              title={downTitle}
              body="Start the dev server; this tab retries every 2 seconds. Or type a workspace file path, like docs/index.html, in the address bar."
            />
          </div>
        )}
        {draft && (
          <PreviewCommentComposer
            key={`${draft.element.selector}-${draft.anchor.top}-${draft.anchor.left}`}
            element={draft.element}
            anchor={draft.anchor}
            bounds={stage}
            onAdd={addComment}
            onCancel={() => setDraft(null)}
          />
        )}
      </div>
      {consoleOpen && (
        <section aria-label="Preview console" className="flex max-h-44 shrink-0 flex-col border-t border-(--color-border) bg-(--bg-page)">
          <div className="flex h-7 shrink-0 items-center gap-2 pr-1 pl-3">
            <p className="min-w-0 flex-1 text-meta text-(--color-text-muted)">
              {consoleEntries.length} {consoleEntries.length === 1 ? 'entry' : 'entries'}
            </p>
            <Button type="button" variant="ghost" size="xs" onClick={() => setConsoleEntries([])} disabled={!consoleEntries.length}>
              Clear
            </Button>
          </div>
          {consoleEntries.length === 0 ? (
            <EmptyState icon={SquareTerminal} title="No console output yet" fill={false} className="flex min-h-0 flex-1 justify-center overflow-y-auto py-4" />
          ) : (
            <ol className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 font-mono text-meta">
              {consoleEntries.map((entry, index) => (
                <li
                  key={index}
                  className={cn(
                    'border-b border-(--color-border-subtle) py-0.5 break-words whitespace-pre-wrap',
                    entry.level === 'error' ? 'text-(--color-error)' : entry.level === 'warn' ? 'text-(--accent-orange-text)' : 'text-(--color-text-2)',
                  )}
                >
                  {entry.message}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {comments.length > 0 && (
        <PreviewCommentList
          comments={comments}
          onRemove={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
          onEdit={(id, text) => setComments((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)))}
          onClear={() => {
            setComments([])
            nextCommentRef.current = 1
          }}
          onSend={sendComments}
        />
      )}
    </div>
  )
}

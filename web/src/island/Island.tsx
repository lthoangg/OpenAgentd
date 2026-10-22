import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, CircleAlert, X } from 'lucide-react'
import { DURATIONS_S } from '@/lib/motion'
import {
  DEFAULT_ISLAND_SETTINGS,
  EAR_WIDTH,
  type IslandMode,
  type IslandPointer,
  type IslandSession,
  type IslandSettings,
  type IslandStatus,
  type IslandView,
  type NotchGeometry,
  allFailed,
  compactLabels,
  islandHeight,
  islandMode,
  islandWidth,
  primarySessionId,
} from './status'

const STATE_COMMAND = 'island_state'
const FIT_COMMAND = 'island_fit'
const OPEN_COMMAND = 'island_open_session'
const DISMISS_COMMAND = 'island_dismiss'
const STATUS_EVENT = 'island-status'
const GEOMETRY_EVENT = 'island-geometry'
const SETTINGS_EVENT = 'island-settings-changed'
/** The shell polls the pointer: WebKit gives no hover to a window that can't take focus. */
const POINTER_EVENT = 'island-pointer'
/** Stable empty list, so effects keyed on it don't rerun every render. */
const NO_SESSIONS: IslandSession[] = []
/** The canvas shows with the pill still inside the notch; it grows out after this. */
const ENTER_DELAY_MS = 34
/** The canvas stays up this long after the pill starts shrinking back in. */
const EXIT_MS = DURATIONS_S.slow * 1000

function openSession(sessionId: string | null) {
  if (sessionId) void invoke(OPEN_COMMAND, { sessionId }).catch(() => {})
}

function dismiss(sessionId: string) {
  void invoke(DISMISS_COMMAND, { sessionId }).catch(() => {})
}

/** Listen to a shell event; the cleanup also works if it runs before `listen` resolves. */
function useShellEvent<T>(event: string, onPayload: (payload: T) => void) {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const stop = await listen<T>(event, (e) => onPayload(e.payload))
      if (cancelled) stop()
      else unlisten = stop
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [event, onPayload])
}

function StateMark({ mode, failed }: { mode: IslandMode; failed: boolean }) {
  if (mode === 'done') {
    return failed
      ? <CircleAlert size={13} className="island-mark island-mark--failed" aria-hidden="true" />
      : <Check size={13} strokeWidth={3} className="island-mark island-mark--done" aria-hidden="true" />
  }
  if (mode === 'needs_input') return <span className="island-dot" aria-hidden="true" />
  return <span className="island-spinner" aria-hidden="true" />
}

function RowMark({ state }: { state: IslandSession['state'] }) {
  if (state === 'needs_input') return <span className="island-dot" aria-hidden="true" />
  if (state === 'done') return <Check size={12} strokeWidth={3} className="island-mark island-mark--done" aria-hidden="true" />
  if (state === 'failed') return <CircleAlert size={12} className="island-mark island-mark--failed" aria-hidden="true" />
  return <span className="island-spinner" aria-hidden="true" />
}

function SessionRow({ session, hover }: { session: IslandSession; hover: RowHover | null }) {
  const hovered = hover?.id === session.id
  const waiting = session.state === 'needs_input'
  const unread = session.state === 'done' || session.state === 'failed'
  return (
    <li className="island-row-item" data-unread={unread ? '' : undefined}>
      <button
        type="button"
        className="island-row"
        data-row={session.id}
        data-hover={hovered ? '' : undefined}
        onClick={() => openSession(session.id)}
      >
        <RowMark state={session.state} />
        <span className="island-row-title">{session.title}</span>
        <span className="island-row-meta">{waiting ? 'Open' : session.workspace}</span>
        {waiting && session.question && <span className="island-row-question">{session.question}</span>}
      </button>
      {unread && (
        <button
          type="button"
          className="island-dismiss"
          data-row={session.id}
          data-dismiss=""
          data-hover={hovered && hover?.dismiss ? '' : undefined}
          aria-label={`Dismiss ${session.title}`}
          onClick={() => dismiss(session.id)}
        >
          <X size={12} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

interface RowHover {
  id: string
  /** Over the row's × rather than the row itself. */
  dismiss: boolean
}

/** The row under the pointer, from the shell's pointer position. */
function rowAt(pointer: IslandPointer | null): RowHover | null {
  if (!pointer?.inside || typeof document.elementFromPoint !== 'function') return null
  const target = document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-row]')
  const id = target?.getAttribute('data-row')
  return id ? { id, dismiss: target?.hasAttribute('data-dismiss') ?? false } : null
}

export function Island() {
  const [status, setStatus] = useState<IslandStatus | null>(null)
  const [geometry, setGeometry] = useState<NotchGeometry | null>(null)
  const [settings, setSettings] = useState<IslandSettings>(DEFAULT_ISLAND_SETTINGS)
  const [pointer, setPointer] = useState<IslandPointer | null>(null)
  const [listHeight, setListHeight] = useState(0)
  /** The pill is out of the notch (false while it grows out or shrinks back). */
  const [open, setOpen] = useState(false)
  /** The pill is shrinking back in; the canvas stays up until it has. */
  const [closing, setClosing] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const wasVisible = useRef(false)
  /** The last snapshot seen; an older one arriving late is dropped. */
  const seenSeq = useRef<number | null>(null)

  const receive = useCallback((next: IslandStatus) => {
    const previous = seenSeq.current
    if (previous !== null && next.seq <= previous) return
    seenSeq.current = next.seq
    setStatus(next)
  }, [])

  useShellEvent<IslandStatus>(STATUS_EVENT, receive)
  useShellEvent<NotchGeometry>(GEOMETRY_EVENT, setGeometry)
  useShellEvent<IslandSettings>(SETTINGS_EVENT, setSettings)
  useShellEvent<IslandPointer>(POINTER_EVENT, setPointer)

  useEffect(() => {
    let cancelled = false
    void invoke<IslandView>(STATE_COMMAND).then((view) => {
      if (cancelled) return
      setGeometry(view.geometry)
      setSettings(view.settings)
      if (seenSeq.current === null) {
        seenSeq.current = view.status.seq
        setStatus(view.status)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const sessions = status?.sessions ?? NO_SESSIONS
  const unread = status?.unread ?? NO_SESSIONS
  const hovered = pointer?.inside ?? false
  const mode = islandMode(sessions, unread, hovered, settings)
  const wantVisible = mode !== 'hidden'

  // Grow out of the notch once the canvas is up; shrink back in, then let
  // the canvas go.
  useEffect(() => {
    if (wantVisible) {
      wasVisible.current = true
      setClosing(false)
      const timer = setTimeout(() => setOpen(true), ENTER_DELAY_MS)
      return () => clearTimeout(timer)
    }
    setOpen(false)
    if (!wasVisible.current) return
    wasVisible.current = false
    setClosing(true)
    const timer = setTimeout(() => setClosing(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [wantVisible])

  // What the pill shows while it shrinks away: the last thing it showed.
  const shown = useRef<{ mode: IslandMode; lead: string; detail: string; failed: boolean }>({
    mode: 'hidden', lead: '', detail: '', failed: false,
  })
  if (wantVisible) {
    const barMode: IslandMode = mode !== 'expanded'
      ? mode
      : sessions.some((s) => s.state === 'needs_input') ? 'needs_input' : sessions.length > 0 ? 'running' : 'done'
    shown.current = { mode: barMode, ...compactLabels(sessions, unread), failed: allFailed(unread) }
  }
  const { mode: barMode, lead, detail, failed } = shown.current

  useLayoutEffect(() => {
    if (mode !== 'expanded' || !listRef.current) return
    setListHeight(listRef.current.scrollHeight)
  }, [mode, sessions, unread])

  const sizeMode: IslandMode = open ? mode : 'hidden'
  const width = geometry ? islandWidth(sizeMode, geometry) : 0
  const height = geometry ? islandHeight(sizeMode, geometry, listHeight) : 0
  const visible = wantVisible || closing

  // Tell the shell where the pill is (its click and hover area) and whether
  // the canvas should be up.
  useLayoutEffect(() => {
    if (!geometry) return
    void invoke(FIT_COMMAND, { width: width + 2 * EAR_WIDTH, height, visible }).catch(() => {})
  }, [geometry, width, height, visible])

  const hoverRow = rowAt(pointer)

  if (!geometry) return null

  const style = {
    '--pill-width': `${width}px`,
    '--pill-height': `${height}px`,
    '--notch-width': `${geometry.hasNotch ? geometry.width : 0}px`,
    '--notch-height': `${geometry.height}px`,
  } as CSSProperties
  const onBar = () => openSession(primarySessionId(sessions, unread))
  const label = `${lead}: ${detail}. Open in OpenAgentd`

  return (
    <div className="island-canvas">
      <div
        className="island"
        data-mode={mode}
        data-open={open ? 'true' : 'false'}
        data-notch={geometry.hasNotch ? 'true' : 'false'}
        style={style}
      >
        <span className="island-ear island-ear--left" aria-hidden="true" />
        <div className="island-body">
          <button type="button" className="island-bar" onClick={onBar} aria-label={wantVisible ? label : 'No active sessions'} tabIndex={wantVisible ? 0 : -1}>
            <span className="island-lead" role="status" aria-live="polite">
              {barMode !== 'hidden' && (
                <span key={barMode} className="island-swap island-lead-inner">
                  <StateMark mode={barMode} failed={failed} />
                  <span className="island-text">{lead}</span>
                </span>
              )}
            </span>
            <span className="island-notch" aria-hidden="true" />
            <span key={`${barMode}:${detail}`} className="island-swap island-detail island-text">{detail}</span>
          </button>
          {mode === 'expanded' && (
            <ul ref={listRef} className="island-list" aria-label="Sessions">
              {sessions.map((session) => <SessionRow key={session.id} session={session} hover={hoverRow} />)}
              {unread.map((session) => <SessionRow key={session.id} session={session} hover={hoverRow} />)}
            </ul>
          )}
        </div>
        <span className="island-ear island-ear--right" aria-hidden="true" />
      </div>
    </div>
  )
}

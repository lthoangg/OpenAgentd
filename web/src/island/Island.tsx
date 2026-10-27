import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, CircleAlert, Pause, X } from 'lucide-react'
import { DURATIONS_S } from '@/lib/motion'
import {
  DEFAULT_ISLAND_SETTINGS,
  type IslandGoal,
  type IslandMode,
  type IslandPointer,
  type IslandSession,
  type IslandSettings,
  type IslandStatus,
  type IslandView,
  type NotchGeometry,
  allFailed,
  compactCount,
  compactLabels,
  compactMode,
  goalLabel,
  islandHitBox,
  islandHeight,
  islandMode,
  islandShift,
  islandWidth,
  listOrder,
  primarySessionId,
} from './status'

const STATE_COMMAND = 'island_state'
const FIT_COMMAND = 'island_fit'
const OPEN_COMMAND = 'island_open_session'
const DISMISS_COMMAND = 'island_dismiss'
const MENU_COMMAND = 'island_context_menu'
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

/** What became of a goal: achieved in blue, blocked as an alert, paused as a pause. */
function GoalOutcomeMark({ goal, size }: { goal: Exclude<IslandGoal['status'], 'active'>; size: number }) {
  if (goal === 'achieved') return <Check size={size} strokeWidth={3} className="island-mark island-mark--goal" aria-hidden="true" />
  if (goal === 'blocked') return <CircleAlert size={size} className="island-mark island-mark--failed" aria-hidden="true" />
  return <Pause size={size} strokeWidth={2.5} className="island-mark island-mark--paused" aria-hidden="true" />
}

/** A finished row's goal outcome, if it ended one. */
function outcomeOf(session: IslandSession | undefined): Exclude<IslandGoal['status'], 'active'> | null {
  const status = session?.goal?.status
  return status && status !== 'active' ? status : null
}

function StateMark({ mode, failed, goal }: { mode: IslandMode; failed: boolean; goal: Exclude<IslandGoal['status'], 'active'> | null }) {
  if (mode === 'done') {
    if (goal) return <GoalOutcomeMark goal={goal} size={13} />
    return failed
      ? <CircleAlert size={13} className="island-mark island-mark--failed" aria-hidden="true" />
      : <Check size={13} strokeWidth={3} className="island-mark island-mark--done" aria-hidden="true" />
  }
  if (mode === 'needs_input') return <span className="island-dot" aria-hidden="true" />
  return <span className="island-spinner" aria-hidden="true" />
}

function RowMark({ session }: { session: IslandSession }) {
  const { state } = session
  const goal = outcomeOf(session)
  if ((state === 'done' || state === 'failed') && goal) return <GoalOutcomeMark goal={goal} size={12} />
  if (state === 'needs_input') return <span className="island-dot" aria-hidden="true" />
  if (state === 'done') return <Check size={12} strokeWidth={3} className="island-mark island-mark--done" aria-hidden="true" />
  if (state === 'failed') return <CircleAlert size={12} className="island-mark island-mark--failed" aria-hidden="true" />
  return <span className="island-spinner" aria-hidden="true" />
}

function SessionRow({ session, hover, onMenu }: {
  session: IslandSession
  hover: RowHover | null
  onMenu: (event: MouseEvent<HTMLElement>, sessionId: string) => void
}) {
  const hovered = hover?.id === session.id
  const waiting = session.state === 'needs_input'
  const unread = session.state === 'done' || session.state === 'failed'
  const meta = [session.server, waiting ? 'Open' : goalLabel(session) ?? session.workspace].filter(Boolean).join(' · ')
  return (
    <li className="island-row-item" data-unread={unread ? '' : undefined} onContextMenu={(event) => onMenu(event, session.id)}>
      <button
        type="button"
        className="island-row"
        data-row={session.id}
        data-hover={hovered ? '' : undefined}
        onClick={() => openSession(session.id)}
      >
        <RowMark session={session} />
        <span className="island-row-title">{session.title}</span>
        <span className="island-row-meta">{meta}</span>
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
  const [menuStatus, setMenuStatus] = useState<IslandStatus | null>(null)
  const [listHeight, setListHeight] = useState(0)
  /** The pill is out of the notch (false while it grows out or shrinks back). */
  const [open, setOpen] = useState(false)
  /** The pill is shrinking back in; the canvas stays up until it has. */
  const [closing, setClosing] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const wasVisible = useRef(false)
  /** The last snapshot seen; an older one arriving late is dropped. */
  const seenSeq = useRef<number | null>(null)

  const onMenu = useCallback((event: MouseEvent<HTMLElement>, sessionId: string | null) => {
    event.preventDefault()
    if (!sessionId || menuStatus || !status) return
    setMenuStatus(status)
    void invoke(MENU_COMMAND, { sessionId, x: event.clientX, y: event.clientY })
      .catch((error: unknown) => console.error('island: context menu failed', error))
      .finally(() => setMenuStatus(null))
  }, [menuStatus, status])

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

  // Live updates still arrive, but cannot shrink the pill under a native menu.
  const displayedStatus = menuStatus ?? status
  const sessions = displayedStatus?.sessions ?? NO_SESSIONS
  const unread = displayedStatus?.unread ?? NO_SESSIONS
  const hovered = menuStatus !== null || (pointer?.inside ?? false)
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
  const shown = useRef<{ mode: IslandMode; lead: string; detail: string; count: number; failed: boolean; goal: Exclude<IslandGoal['status'], 'active'> | null }>({
    mode: 'hidden', lead: '', detail: '', count: 0, failed: false, goal: null,
  })
  if (wantVisible) {
    shown.current = {
      mode: compactMode(sessions, unread),
      ...compactLabels(sessions, unread),
      count: compactCount(sessions, unread),
      failed: allFailed(unread),
      // One unread goal names its outcome, so its mark shows it too.
      goal: unread.length === 1 ? outcomeOf(unread[0]) : null,
    }
  }
  const { mode: barMode, lead, detail, count, failed, goal: barGoal } = shown.current

  useLayoutEffect(() => {
    if (mode !== 'expanded' || !listRef.current) return
    setListHeight(listRef.current.scrollHeight)
  }, [mode, sessions, unread])

  const sizeMode: IslandMode = open ? mode : 'hidden'
  const width = geometry ? islandWidth(sizeMode, geometry) : 0
  const height = geometry ? islandHeight(sizeMode, geometry, listHeight) : 0
  const shift = geometry ? islandShift(sizeMode, geometry) : 0
  const visible = wantVisible || closing

  // Tell the shell where the pill is (its click and hover area) and whether
  // the canvas should be up.
  useLayoutEffect(() => {
    if (!geometry) return
    const hit = islandHitBox(sizeMode, geometry, width)
    void invoke(FIT_COMMAND, { width: hit.width, height, visible, shift: hit.shift }).catch(() => {})
  }, [geometry, sizeMode, width, height, visible])

  const hoverRow = rowAt(pointer)

  if (!geometry) return null

  const style = {
    '--pill-width': `${width}px`,
    '--pill-height': `${height}px`,
    '--pill-shift': `${shift}px`,
    '--notch-width': `${geometry.hasNotch ? geometry.width : 0}px`,
    '--notch-height': `${geometry.height}px`,
  } as CSSProperties
  const onBar = () => openSession(primarySessionId(sessions, unread))
  const label = `${lead}: ${detail}. Open in OpenAgentd`

  return (
    <div className="island-canvas" onContextMenu={(event) => event.preventDefault()}>
      <div
        className="island"
        data-mode={mode}
        data-open={open ? 'true' : 'false'}
        data-notch={geometry.hasNotch ? 'true' : 'false'}
        style={style}
      >
        <span className="island-ear island-ear--left" aria-hidden="true" />
        <div className="island-body">
          <button type="button" className="island-bar" onClick={onBar} onContextMenu={(event) => onMenu(event, primarySessionId(sessions, unread))} aria-label={wantVisible ? label : 'No active sessions'} tabIndex={wantVisible ? 0 : -1}>
            <span className="island-lead" role="status" aria-live="polite">
              {barMode !== 'hidden' && (
                <span key={barMode} className="island-swap island-lead-inner">
                  <StateMark mode={barMode} failed={failed} goal={barGoal} />
                  <span className="island-text">{lead}</span>
                  {count > 1 && <span className="island-count" aria-hidden="true">{count}</span>}
                </span>
              )}
            </span>
            <span className="island-notch" aria-hidden="true" />
            <span key={`${barMode}:${detail}`} className="island-swap island-detail island-text">{detail}</span>
          </button>
          {mode === 'expanded' && (
            <ul ref={listRef} className="island-list" aria-label="Sessions">
              {listOrder(sessions, unread).map((session) => <SessionRow key={session.id} session={session} hover={hoverRow} onMenu={onMenu} />)}
            </ul>
          )}
        </div>
        <span className="island-ear island-ear--right" aria-hidden="true" />
      </div>
    </div>
  )
}

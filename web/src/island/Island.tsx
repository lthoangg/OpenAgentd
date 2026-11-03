import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, CircleAlert, Pause, WifiOff, X } from 'lucide-react'
import { DURATIONS_S } from '@/lib/motion'
import {
  DEFAULT_ISLAND_SETTINGS,
  STATE_WORD,
  type IslandGoal,
  type IslandMode,
  type IslandPointer,
  type IslandSession,
  type IslandSettings,
  type IslandStatus,
  type IslandView,
  type NotchGeometry,
  type UnreachableServer,
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
  rowSignature,
  serverSignature,
  serversWithoutLater,
  withoutLater,
} from './status'

const STATE_COMMAND = 'island_state'
const FIT_COMMAND = 'island_fit'
const OPEN_COMMAND = 'island_open_session'
const RETRY_COMMAND = 'island_retry'
const MENU_COMMAND = 'island_context_menu'
const STATUS_EVENT = 'island-status'
const GEOMETRY_EVENT = 'island-geometry'
const SETTINGS_EVENT = 'island-settings-changed'
/** The shell polls the pointer: WebKit gives no hover to a window that can't take focus. */
const POINTER_EVENT = 'island-pointer'
/** Stable empty lists, so effects keyed on them don't rerun every render. */
const NO_SESSIONS: IslandSession[] = []
const NO_SERVERS: UnreachableServer[] = []
/** The canvas shows with the pill still inside the notch; it grows out after this. */
const ENTER_DELAY_MS = 34
/** The canvas stays up this long after the pill starts shrinking back in. */
const EXIT_MS = DURATIONS_S.slow * 1000
/** A list opened by a click closes once the pointer has been away this long. */
const PINNED_LEAVE_MS = 2500

function openSession(sessionId: string | null) {
  if (sessionId) void invoke(OPEN_COMMAND, { sessionId }).catch(() => {})
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
  if (mode === 'offline') return <WifiOff size={13} className="island-mark island-mark--paused" aria-hidden="true" />
  if (mode === 'needs_input') return <span className="island-dot" aria-hidden="true" />
  return <span className="island-spinner" aria-hidden="true" />
}

/** The word that says a row's state: colour alone never does. A running row shows the spinner, no word. */
function StateChip({ session }: { session: IslandSession }) {
  if (session.state === 'running') return <span className="island-spinner" aria-hidden="true" />
  return <span className="island-chip" data-state={session.state}>{STATE_WORD[session.state]}</span>
}

/** Which control the pointer is over, as `data-hit` keys it (the shell sends positions, not :hover). */
function hitAt(pointer: IslandPointer | null): string | null {
  if (!pointer?.inside || typeof document.elementFromPoint !== 'function') return null
  return document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-hit]')?.getAttribute('data-hit') ?? null
}

interface RowActions {
  hit: string | null
  onMenu: (event: MouseEvent<HTMLElement>, sessionId: string) => void
  onLater: (session: IslandSession) => void
}

/** A row only tells: a click on it opens the session, where the details (and any answer) are. */
function SessionRow({ session, actions }: { session: IslandSession; actions: RowActions }) {
  const { hit, onMenu, onLater } = actions
  const waiting = session.state === 'needs_input'
  const attention = waiting || session.state === 'done' || session.state === 'failed'
  const meta = [session.server, goalLabel(session) ?? session.workspace].filter(Boolean).join(' · ')
  const hover = (key: string) => (hit === key ? '' : undefined)
  return (
    <li className="island-row-item" data-state={session.state} onContextMenu={(event) => onMenu(event, session.id)}>
      <button
        type="button"
        className="island-row"
        data-row={session.id}
        data-hit={`row:${session.id}`}
        data-hover={hover(`row:${session.id}`)}
        onClick={() => openSession(session.id)}
      >
        <StateChip session={session} />
        <span className="island-row-title">{session.title}</span>
        <span className="island-row-meta">{meta}</span>
        {waiting && session.question && <span className="island-row-question">{session.question}</span>}
      </button>
      {attention && (
        <button
          type="button"
          className="island-later"
          data-hit={`later:${session.id}`}
          data-hover={hover(`later:${session.id}`)}
          data-tip="Later"
          aria-label={`Later: ${session.title}`}
          onClick={() => onLater(session)}
        >
          <X size={14} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

/** A server that dropped off: a click on the row tries to reach it again. */
function ServerRow({ server, hit, onRetry, onLater }: {
  server: UnreachableServer
  hit: string | null
  onRetry: () => void
  onLater: (server: UnreachableServer) => void
}) {
  const retry = `retry:${server.id}`
  const later = `later:server:${server.id}`
  const reason = server.reason === 'key_rejected' ? 'Access key rejected' : 'Not answering'
  return (
    <li className="island-row-item island-row-item--server" data-state="offline">
      <button
        type="button"
        className="island-row"
        data-hit={retry}
        data-hover={hit === retry ? '' : undefined}
        aria-label={`Can't reach ${server.name}: ${reason}. Try again`}
        onClick={onRetry}
      >
        <span className="island-chip" data-state="offline">Can't reach</span>
        <span className="island-row-title">{server.name}</span>
        <span className="island-row-meta">{reason}</span>
      </button>
      <button
        type="button"
        className="island-later"
        data-hit={later}
        data-hover={hit === later ? '' : undefined}
        data-tip="Later"
        aria-label={`Later: ${server.name}`}
        onClick={() => onLater(server)}
      >
        <X size={14} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </li>
  )
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
  /** The list was opened by a click on the pill. */
  const [pinned, setPinned] = useState(false)
  /** Rows put off with "Later", by row id → what they looked like (see `rowSignature`). */
  const [later, setLater] = useState<ReadonlyMap<string, string>>(() => new Map())
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
  const allSessions = displayedStatus?.sessions ?? NO_SESSIONS
  const allUnread = displayedStatus?.unread ?? NO_SESSIONS
  const allServers = displayedStatus?.unreachable ?? NO_SERVERS
  // What is on show: rows put off for later stay away until something about
  // them changes.
  const sessions = useMemo(() => withoutLater(allSessions, later), [allSessions, later])
  const unread = useMemo(() => withoutLater(allUnread, later), [allUnread, later])
  const servers = useMemo(() => serversWithoutLater(allServers, later), [allServers, later])
  const hovered = menuStatus !== null || (pointer?.inside ?? false)
  const mode = islandMode(sessions, unread, hovered, settings, pinned, servers)
  const wantVisible = mode !== 'hidden'

  // The list a click opened closes again once the pointer has been away a while.
  useEffect(() => {
    if (!pinned) return
    if (!wantVisible) {
      setPinned(false)
      return
    }
    if (hovered) return
    const timer = setTimeout(() => setPinned(false), PINNED_LEAVE_MS)
    return () => clearTimeout(timer)
  }, [pinned, hovered, wantVisible])

  // Rows that came back (changed) or went away leave nothing behind.
  useEffect(() => {
    if (later.size === 0) return
    const live = new Map<string, string>()
    for (const row of [...allSessions, ...allUnread]) live.set(row.id, rowSignature(row))
    for (const server of allServers) live.set(`server:${server.id}`, serverSignature(server))
    const kept = [...later].filter(([key, signature]) => live.get(key) === signature)
    if (kept.length !== later.size) setLater(new Map(kept))
  }, [later, allSessions, allUnread, allServers])

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
      mode: compactMode(sessions, unread, servers),
      ...compactLabels(sessions, unread, servers),
      count: compactCount(sessions, unread, servers),
      failed: allFailed(unread),
      // One unread goal names its outcome, so its mark shows it too.
      goal: unread.length === 1 ? outcomeOf(unread[0]) : null,
    }
  }
  const { mode: barMode, lead, detail, count, failed, goal: barGoal } = shown.current

  useLayoutEffect(() => {
    if (mode !== 'expanded' || !listRef.current) return
    setListHeight(listRef.current.scrollHeight)
  }, [mode, sessions, unread, servers])

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

  const hit = hitAt(pointer)

  const putOff = useCallback((key: string, signature: string) => {
    setLater((current) => new Map(current).set(key, signature))
  }, [])

  const rowActions: RowActions = {
    hit,
    onMenu,
    onLater: (session) => putOff(session.id, rowSignature(session)),
  }

  if (!geometry) return null

  const style = {
    '--pill-width': `${width}px`,
    '--pill-height': `${height}px`,
    '--pill-shift': `${shift}px`,
    '--notch-width': `${geometry.hasNotch ? geometry.width : 0}px`,
    '--notch-height': `${geometry.height}px`,
  } as CSSProperties
  const primary = primarySessionId(sessions, unread)
  // A click opens the list; with hover on, the list is already open and a
  // click on the bar goes to the session it names. Opened by a click, the
  // bar closes it again.
  const onBar = () => {
    if (mode !== 'expanded' && !settings.expandOnHover) setPinned(true)
    else if (pinned) setPinned(false)
    else openSession(primary)
  }
  const barAction = mode === 'expanded' ? (pinned ? 'Close the list' : 'Open in OpenAgentd') : 'Show the list'
  const label = `${lead ? `${lead}: ` : ''}${detail}. ${barAction}`

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
          <button type="button" className="island-bar" onClick={onBar} onContextMenu={(event) => onMenu(event, primary)} aria-label={wantVisible ? label : 'No active sessions'} aria-expanded={mode === 'expanded'} tabIndex={wantVisible ? 0 : -1}>
            <span className="island-lead" role="status" aria-live="polite">
              {barMode !== 'hidden' && (
                <span key={barMode} className="island-swap island-lead-inner">
                  <StateMark mode={barMode} failed={failed} goal={barGoal} />
                  {lead && <span className="island-text">{lead}</span>}
                  {count > 1 && <span className="island-count" aria-hidden="true">{count}</span>}
                </span>
              )}
            </span>
            <span className="island-notch" aria-hidden="true" />
            <span key={`${barMode}:${detail}`} className="island-swap island-detail island-text">{detail}</span>
          </button>
          {mode === 'expanded' && (
            <ul ref={listRef} className="island-list" aria-label="Sessions">
              {listOrder(sessions, unread).map((session) => <SessionRow key={session.id} session={session} actions={rowActions} />)}
              {servers.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  hit={hit}
                  onRetry={() => void invoke(RETRY_COMMAND).catch(() => {})}
                  onLater={(item) => putOff(`server:${item.id}`, serverSignature(item))}
                />
              ))}
            </ul>
          )}
        </div>
        <span className="island-ear island-ear--right" aria-hidden="true" />
      </div>
    </div>
  )
}

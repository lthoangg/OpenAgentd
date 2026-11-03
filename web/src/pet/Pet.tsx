import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlarmClock, Check, CircleAlert, MessageCircleQuestion, X } from 'lucide-react'

import { sessionKey } from '@/lib/session-key'
import { BALLOON_COLUMNS, BALLOON_ROWS, balloonRows, poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from './sprites'
import {
  BALLOON_AWAY_MS,
  BALLOON_POP_MS,
  BUBBLE_FADE_MS,
  CHARACTER_TRAITS,
  DUST_MS,
  EMPTY_BUBBLES,
  FOLD_MS,
  JUMP_MS,
  LADDER_FOLD_MS,
  LADDER_GROW_MS,
  LAND_MS,
  PANT_MS,
  PET_HEIGHT,
  PET_WIDTH,
  POUNCE_AFTER_MS,
  SIZE_SCALE,
  WALK_SPEED,
  ZOOM_DASHES,
  ZOOM_SPEED,
  badgeCount,
  badgeLabel,
  bubbleBelow,
  bubbleLeft,
  bubbleReducer,
  chooseLift,
  clampX,
  clampY,
  climbMs,
  dashTarget,
  dropFalls,
  fallCapped,
  fallMs,
  fallTarget,
  floatMs,
  followLedge,
  ladderBox,
  readOnDismiss,
  ledges,
  nextTarget,
  petPose,
  reactionFor,
  sitPause,
  startX,
  startY,
  visibleBubble,
  withinPounce,
  zoomDelay,
  zoomsWhenDone,
  type BalloonPlan,
  type BubbleTone,
  type Ledge,
  type PetBubble,
  type PetCharacter,
  type PetColour,
  type PetMovement,
  type PetPose,
  type PetReaction,
  type PetView,
  type OtherWindow,
  type Perch,
  type ZoomPhase,
} from './state'

const STATE_COMMAND = 'pet_state'
const FIT_COMMAND = 'pet_fit'
const OPEN_COMMAND = 'pet_open'
const ANSWER_COMMAND = 'pet_answer'
const DISMISS_COMMAND = 'pet_dismiss'
const DRAG_END_COMMAND = 'pet_drag_end'
const MENU_COMMAND = 'pet_menu'
const STATE_EVENT = 'pet-state'
const NOTIFICATION_EVENT = 'pet-notification'
const MENU_EVENT = 'pet-menu-action'
/** A session was read somewhere (an app window, the notch, here). */
const SESSION_READ_EVENT = 'pet-session-read'
/** A session's question was answered somewhere (here, the notch, a notification, the app). */
const QUESTION_ANSWERED_EVENT = 'pet-question-answered'
/** Where the pointer is while it is near the pet (CSS px), or null once it leaves. */
const POINTER_EVENT = 'pet-pointer'
/** Other apps' windows it can climb, front first (CSS px); empty when it may not. */
const WINDOWS_EVENT = 'pet-windows'
/** A press that moves less than this is a click, not a drag. */
const DRAG_SLOP = 4
const REACTION_MS: Record<PetReaction, number> = { hop: 1700, droop: 2500, look: 2000 }
/** How often the hit areas are re-sent while the pet walks. */
const FIT_EVERY_MS = 100
/** How long the pet's reply to a poke stays up. */
const POKE_SAY_MS = 2500

type MenuAction = { action: 'dismiss'; id: string } | { action: 'clear' }

/** An answer being sent, or one the shell could not take, by bubble id. */
type Answering = 'sending' | 'failed'

/** Dismissed finished turns and reminders: their sessions are read everywhere. */
function reportDismissed(items: PetBubble[]): void {
  const notificationIds = readOnDismiss(items)
  if (notificationIds.length > 0) void invoke(DISMISS_COMMAND, { notificationIds }).catch(() => {})
}
type PointerAt = { x: number; y: number } | null
/** The laptop being folded before a walk, or opened after one. */
type Fold = 'folding' | 'unfolding'

/**
 * A ladder, a balloon or a fall under way. `ms` and `ease` are how the pet's
 * move to its new place goes (CSS does the moving: one transition on the
 * pet, no per-frame work in the page).
 */
type Lift = { ms: number; ease: string } & (
  | { kind: 'ladder'; phase: 'grow' | 'climb' | 'fold'; up: boolean; box: { left: number; top: number; width: number; height: number } }
  | { kind: 'balloon'; phase: 'rise' | 'hover' | 'release' }
  | { kind: 'fall'; phase: 'fall' | 'land' }
)

/** The pose of a move: it sits while a ladder grows or folds, and after a landing. */
function liftPose(lift: Lift | null): 'sit' | 'climb' | 'float' | 'fall' | null {
  if (!lift) return null
  if (lift.kind === 'ladder') return lift.phase === 'climb' ? 'climb' : 'sit'
  if (lift.kind === 'balloon') return lift.phase === 'release' ? 'sit' : 'float'
  return lift.phase === 'fall' ? 'fall' : 'sit'
}

const LINEAR = 'var(--ease-linear)'
const EASE_IN_OUT = 'var(--ease-in-out)'
const EASE_OUT = 'var(--ease-out)'

function BalloonArt({ popped }: { popped: boolean }) {
  return (
    <svg viewBox={`0 0 ${BALLOON_COLUMNS} ${BALLOON_ROWS}`} shapeRendering="crispEdges" aria-hidden="true">
      {spriteRects(balloonRows(popped), 'orange').map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  )
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

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const onChange = () => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function Sprite({ character, pose, colour }: { character: PetCharacter; pose: PetPose; colour: PetColour }) {
  const frames = poseFrames(character, pose)
  return (
    <>
      {frames.map((rows, i) => (
        <svg
          key={i}
          className={`pet-frame pet-frame--${i}`}
          viewBox={`0 0 ${SPRITE_COLUMNS} ${SPRITE_ROWS}`}
          shapeRendering="crispEdges"
          aria-hidden="true"
        >
          {spriteRects(rows, colour).map((r) => (
            <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
          ))}
        </svg>
      ))}
    </>
  )
}

const TONE_LABEL: Record<BubbleTone, string> = {
  input: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  remind: 'Reminder',
}

function ToneMark({ tone }: { tone: BubbleTone }) {
  const size = 12
  if (tone === 'input') return <MessageCircleQuestion size={size} aria-hidden="true" />
  if (tone === 'failed') return <CircleAlert size={size} aria-hidden="true" />
  if (tone === 'remind') return <AlarmClock size={size} aria-hidden="true" />
  return <Check size={size} aria-hidden="true" />
}

export function Pet() {
  const [view, setView] = useState<PetView | null>(null)
  const [bubbles, dispatch] = useReducer(bubbleReducer, EMPTY_BUBBLES)
  // The menu's Clear arrives as an event: it reads what is up then.
  const bubblesRef = useRef(bubbles)
  bubblesRef.current = bubbles
  const [reaction, setReaction] = useState<PetReaction | null>(null)
  const [sitting, setSitting] = useState(true)
  const [lastActivity, setLastActivity] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [width, setWidth] = useState(() => window.innerWidth)
  const [height, setHeight] = useState(() => window.innerHeight)
  const [x, setX] = useState<number | null>(null)
  const [y, setY] = useState(0)
  const [facingLeft, setFacingLeft] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [zoom, setZoom] = useState<ZoomPhase | null>(null)
  const [pointer, setPointer] = useState<PointerAt>(null)
  const [windows, setWindows] = useState<OtherWindow[]>([])
  const [jumping, setJumping] = useState(false)
  const [lift, setLiftState] = useState<Lift | null>(null)
  /** The balloon over its head: whole, popping, or let go. */
  const [balloon, setBalloon] = useState<'float' | 'pop' | 'away' | null>(null)
  const [dust, setDust] = useState<{ x: number; y: number; at: number } | null>(null)
  const [say, setSay] = useState<{ text: string; at: number } | null>(null)
  const [fold, setFold] = useState<Fold | null>(null)
  const [answering, setAnswering] = useState<ReadonlyMap<string, Answering>>(() => new Map())
  const reducedMotion = useReducedMotion()

  const petRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const xRef = useRef(0)
  /** The height it stands at on the ground (where it was placed or dropped). */
  const groundRef = useRef(0)
  /** The window it stands on, if any. */
  const perchRef = useRef<Perch | null>(null)
  const jumpTimerRef = useRef(0)
  const liftRef = useRef<Lift | null>(null)
  /** The timer of the next step of the ladder, balloon or fall under way. */
  const liftTimerRef = useRef(0)
  const popTimerRef = useRef(0)
  const dustTimerRef = useRef(0)
  /** The window it stood on when a ladder started down: put back if the ladder is called off. */
  const perchBeforeRef = useRef<Perch | null>(null)
  /** A drop is waiting for the pet to be placed before it falls (dropped over another display). */
  const fallOnPlaceRef = useRef(false)
  /** Where the page last told the shell the pet was dropped, to tell the shell's echo from a move. */
  const reportedRef = useRef<{ x: number; y: number; frame: string } | null>(null)
  const startFallRef = useRef<() => void>(() => {})
  const balloonRef = useRef<HTMLButtonElement>(null)
  const yRef = useRef(0)
  const targetRef = useRef<number | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; petX: number; petY: number; moved: boolean } | null>(null)
  const lastFitRef = useRef('')
  const dashesRef = useRef(0)
  /** A finished turn asked for zoomies; they start once nothing holds the pet. */
  const zoomPendingRef = useRef(false)
  const movementRef = useRef<PetMovement>('calm')

  const settings = view?.settings
  movementRef.current = settings?.movement ?? 'calm'
  // An unknown name (a newer shell) draws the cat.
  const character: PetCharacter = settings && settings.character in CHARACTER_TRAITS ? settings.character : 'cat'
  const traits = CHARACTER_TRAITS[character]
  const status = view?.status ?? { running: 0, needsInput: 0 }
  const busy = status.running > 0
  const scale = settings ? SIZE_SCALE[settings.size] : 1
  const petWidth = PET_WIDTH * scale
  const petHeight = PET_HEIGHT * scale
  const visible = visibleBubble(bubbles)
  const badge = badgeCount(bubbles)
  const badgeText = badgeLabel(bubbles)
  const active = Boolean(settings?.enabled && view?.shown)

  // ── Shell data ──────────────────────────────────────────────────────────
  const applyView = useCallback((next: PetView) => {
    setView(next)
    dispatch({ type: 'status', status: next.status })
    if (next.status.running > 0 || next.status.needsInput > 0) setLastActivity(Date.now())
    if (!next.settings.enabled) dispatch({ type: 'clear' })
  }, [])

  useEffect(() => {
    void invoke<PetView>(STATE_COMMAND).then(applyView).catch(() => {})
  }, [applyView])
  useShellEvent<PetView>(STATE_EVENT, applyView)
  useShellEvent<PetBubble>(
    NOTIFICATION_EVENT,
    useCallback((bubble: PetBubble) => {
      dispatch({ type: 'notify', bubble })
      setLastActivity(Date.now())
      setReaction(reactionFor(bubble.tone))
      if (bubble.tone === 'done' && zoomsWhenDone(movementRef.current)) zoomPendingRef.current = true
    }, []),
  )
  // Items of the right-click menu that change the bubbles.
  useShellEvent<MenuAction>(
    MENU_EVENT,
    useCallback((payload: MenuAction) => {
      if (payload.action === 'dismiss') dispatch({ type: 'dismiss', id: payload.id })
      else {
        const { current, unread } = bubblesRef.current
        reportDismissed(current ? [current, ...unread] : unread)
        dispatch({ type: 'clearUnread' })
      }
    }, []),
  )
  useShellEvent<{ sessionKey: string }>(
    SESSION_READ_EVENT,
    useCallback((payload: { sessionKey: string }) => {
      if (typeof payload?.sessionKey === 'string') dispatch({ type: 'readSession', key: payload.sessionKey })
    }, []),
  )
  useShellEvent<{ sessionKey: string }>(
    QUESTION_ANSWERED_EVENT,
    useCallback((payload: { sessionKey: string }) => {
      if (typeof payload?.sessionKey === 'string') dispatch({ type: 'answered', key: payload.sessionKey })
    }, []),
  )
  useShellEvent<PointerAt>(POINTER_EVENT, setPointer)
  useShellEvent<OtherWindow[]>(WINDOWS_EVENT, setWindows)

  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth)
      setHeight(window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The clock only matters for falling asleep.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!reaction) return
    const timer = window.setTimeout(() => setReaction(null), REACTION_MS[reaction])
    return () => window.clearTimeout(timer)
  }, [reaction])

  useEffect(() => {
    if (!say) return
    const timer = window.setTimeout(() => setSay(null), POKE_SAY_MS)
    return () => window.clearTimeout(timer)
  }, [say])

  // A finished turn or reminder fades behind the badge.
  const fadingId = visible?.type === 'bubble' && visible.fades ? visible.bubble.id : null
  useEffect(() => {
    if (!fadingId) return
    const timer = window.setTimeout(() => dispatch({ type: 'fade', id: fadingId }), BUBBLE_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [fadingId])

  // ── Position ────────────────────────────────────────────────────────────
  // The window covers the display's work area. The pet is placed once its
  // size and the saved spot are known, and again when the shell moves it
  // (dropped on another display). It walks left and right at that height.
  const savedFraction = settings?.position?.x
  const savedHeight = settings?.position?.y
  const savedDisplay = settings?.position?.display
  const ready = settings !== undefined
  useEffect(() => {
    if (!ready || width <= 0 || height <= 0) return
    const saved = savedFraction === undefined ? null : { display: savedDisplay ?? '', x: savedFraction, y: savedHeight }
    // The shell echoes the spot the page just reported (a drop that falls
    // reports where it will land): the pet is there already, or on its way.
    const echo = reportedRef.current
    const frame = `${width}|${height}|${petWidth}|${petHeight}`
    if (echo && echo.frame === frame && saved && Math.abs(saved.x - echo.x / width) < 0.002 && Math.abs((saved.y ?? 1) - echo.y / height) < 0.002) return
    const start = startX(saved, width, petWidth)
    window.clearTimeout(liftTimerRef.current)
    liftRef.current = null
    setLiftState(null)
    setBalloon(null)
    xRef.current = start
    yRef.current = startY(saved, height, petHeight)
    groundRef.current = yRef.current
    perchRef.current = null
    targetRef.current = null
    setX(start)
    setY(yRef.current)
    // Dropped onto another display, in mid-air: it falls there too.
    if (fallOnPlaceRef.current) {
      groundRef.current = Math.max(0, height - petHeight)
      liftTimerRef.current = window.setTimeout(() => startFallRef.current(), 60)
    }
  }, [ready, savedFraction, savedHeight, savedDisplay, width, height, petWidth, petHeight])

  const held = dragging || menuOpen || jumping || lift !== null || visible !== null
  const pose = petPose({
    status,
    reaction,
    sitting,
    held,
    zoom,
    lift: liftPose(lift),
    idleMs: now - lastActivity,
    reducedMotion,
    movement: settings?.movement ?? 'calm',
  })
  const zooming = pose === 'zoom'
  const walking = active && (pose === 'walk' || zooming)
  /** An agent runs and it is on the move: the laptop rides folded on its back. */
  const carrying = busy && (pose === 'walk' || jumping)
  const heldRef = useRef(held)
  heldRef.current = held
  const busyRef = useRef(busy)
  busyRef.current = busy
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion

  // ── Zoomies ─────────────────────────────────────────────────────────────
  const startZoom = useCallback(() => {
    zoomPendingRef.current = false
    dashesRef.current = ZOOM_DASHES
    targetRef.current = null
    setSitting(false)
    setZoom('run')
  }, [])

  // Now and then on its own (chaotic only, and not while an agent runs).
  useEffect(() => {
    if (!settings || zoom !== null || reducedMotion) return
    const delay = zoomDelay(settings.movement, Math.random(), busy)
    if (delay === null) return
    const timer = window.setTimeout(startZoom, delay)
    return () => window.clearTimeout(timer)
  }, [settings, zoom, reducedMotion, startZoom, busy])

  // A turn starting ends a bout: it goes back to work.
  useEffect(() => {
    if (busy) setZoom(null)
  }, [busy])

  // After a finished turn, once its bubble and hop are over.
  useEffect(() => {
    if (!zoomPendingRef.current || !active || zoom !== null || held || reaction || busy) return
    if (reducedMotion || !zoomsWhenDone(settings?.movement ?? 'calm')) {
      zoomPendingRef.current = false
      return
    }
    startZoom()
  }, [active, zoom, held, reaction, busy, reducedMotion, settings?.movement, startZoom])

  useEffect(() => {
    if (zoom !== 'pant') return
    const timer = window.setTimeout(() => {
      setZoom(null)
      setSitting(true)
    }, PANT_MS)
    return () => window.clearTimeout(timer)
  }, [zoom])

  // ── Climbing on windows ─────────────────────────────────────────────────
  const allLedges = useMemo(() => ledges(windows, { width, height }, { width: petWidth, height: petHeight }), [windows, width, height, petWidth, petHeight])
  const ledgesRef = useRef(allLedges)
  ledgesRef.current = allLedges
  const movement = settings?.movement ?? 'calm'

  /** Jump (CSS animates the move) to `x`, with its feet `y` above the edge. */
  const jumpTo = useCallback((nextX: number, nextY: number) => {
    targetRef.current = null
    xRef.current = nextX
    yRef.current = nextY
    setX(nextX)
    setY(nextY)
    setJumping(true)
    window.clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      setJumping(false)
      setSitting(false)
    }, JUMP_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(jumpTimerRef.current), [])

  // ── Ladders, balloons and falls ─────────────────────────────────────────
  // Each is a short chain of timers (a phase per step) that changes the
  // pet's target and lets one CSS transition do the moving, like a jump.
  const geomRef = useRef({ petWidth, petHeight, width, height })
  geomRef.current = { petWidth, petHeight, width, height }
  const climbRef = useRef(false)
  climbRef.current = Boolean(settings?.climb)
  const toysRef = useRef(true)
  toysRef.current = settings?.toys ?? true
  const needsInputRef = useRef(0)
  needsInputRef.current = status.needsInput

  const setLift = useCallback((next: Lift | null) => {
    liftRef.current = next
    setLiftState(next)
  }, [])

  const place = useCallback((nextX: number, nextY: number) => {
    targetRef.current = null
    xRef.current = nextX
    yRef.current = nextY
    setX(nextX)
    setY(nextY)
  }, [])

  /** Where the pet is drawn now, mid-move; null when it cannot be measured. */
  const visualSpot = useCallback((): { x: number; y: number } | null => {
    const rect = petRef.current?.getBoundingClientRect()
    return rect && rect.width > 0 ? { x: rect.left, y: rect.top } : null
  }, [])

  /** Stop whatever is under way where it stands, without a fall. */
  const dropLift = useCallback(() => {
    window.clearTimeout(liftTimerRef.current)
    window.clearTimeout(popTimerRef.current)
    window.clearTimeout(dustTimerRef.current)
    fallOnPlaceRef.current = false
    setLift(null)
    setBalloon(null)
    setDust(null)
  }, [setLift])
  useEffect(
    () => () => {
      window.clearTimeout(liftTimerRef.current)
      window.clearTimeout(popTimerRef.current)
      window.clearTimeout(dustTimerRef.current)
    },
    [],
  )

  /**
   * Fall to the nearest surface below (a window edge it is over, or the
   * ground): gravity, a squash on landing and a puff of dust. With motion
   * reduced or told to stay put it is just there.
   */
  const startFall = useCallback(() => {
    window.clearTimeout(liftTimerRef.current)
    const { petWidth: pw, petHeight: ph } = geomRef.current
    // Mid-move it falls from where it is drawn now.
    const spot = liftRef.current ? visualSpot() : null
    if (spot) {
      xRef.current = spot.x
      yRef.current = spot.y
    }
    const target = fallTarget({ x: xRef.current, y: yRef.current }, climbRef.current ? ledgesRef.current : [], groundRef.current, { width: pw, height: ph })
    perchRef.current = target.ledge ? { id: target.ledge.id, ledgeX: target.ledge.x } : null
    const distance = target.y - yRef.current
    const done = () => {
      fallOnPlaceRef.current = false
      setLift(null)
      setSitting(true)
    }
    if (reducedMotionRef.current || movementRef.current === 'still' || distance < 1) {
      place(target.x, target.y)
      done()
      return
    }
    const capped = fallCapped(distance)
    const ms = fallMs(distance)
    setSitting(false)
    setLift({ kind: 'fall', phase: 'fall', ms, ease: capped ? 'var(--pet-fall-capped-ease)' : 'var(--pet-fall-ease)' })
    place(target.x, target.y)
    liftTimerRef.current = window.setTimeout(() => {
      setLift({ kind: 'fall', phase: 'land', ms: 0, ease: LINEAR })
      window.clearTimeout(dustTimerRef.current)
      setDust({ x: target.x + pw / 2, y: target.y + ph, at: Date.now() })
      dustTimerRef.current = window.setTimeout(() => setDust(null), DUST_MS)
      liftTimerRef.current = window.setTimeout(done, LAND_MS)
    }, ms)
  }, [place, setLift, visualSpot])
  startFallRef.current = startFall

  /** The balloon pops (clicked, or its hover is over): the pet falls. */
  const popBalloon = useCallback(() => {
    const current = liftRef.current
    if (current?.kind !== 'balloon' || current.phase === 'release') return
    window.clearTimeout(liftTimerRef.current)
    window.clearTimeout(popTimerRef.current)
    if (reducedMotionRef.current) {
      setBalloon(null)
    } else {
      setBalloon('pop')
      popTimerRef.current = window.setTimeout(() => setBalloon(null), BALLOON_POP_MS)
    }
    startFall()
  }, [startFall])

  /** Rise on a balloon: up and a little aside, then hover and pop, or step onto a window edge. */
  const startBalloon = useCallback(
    (plan: BalloonPlan) => {
      const { petWidth: pw, petHeight: ph } = geomRef.current
      const ms = floatMs(yRef.current - plan.toY)
      if (plan.toX !== xRef.current) setFacingLeft(plan.toX < xRef.current)
      perchRef.current = null
      setSitting(false)
      setBalloon('float')
      setLift({ kind: 'balloon', phase: 'rise', ms, ease: EASE_IN_OUT })
      place(plan.toX, plan.toY)
      liftTimerRef.current = window.setTimeout(() => {
        if (!plan.ledge) {
          setLift({ kind: 'balloon', phase: 'hover', ms: 0, ease: LINEAR })
          liftTimerRef.current = window.setTimeout(popBalloon, plan.hoverMs)
          return
        }
        // Over its edge: step onto it (where it is now) and let the balloon go.
        const next = followLedge({ id: plan.ledge.id, ledgeX: plan.ledge.x }, xRef.current, ledgesRef.current, { width: pw, height: ph })
        if (!next) {
          popBalloon()
          return
        }
        perchRef.current = next.perch
        if (next.x !== xRef.current || next.y !== yRef.current) place(next.x, next.y)
        setBalloon('away')
        setLift({ kind: 'balloon', phase: 'release', ms: 0, ease: LINEAR })
        liftTimerRef.current = window.setTimeout(() => {
          setBalloon(null)
          setLift(null)
          setSitting(true)
        }, BALLOON_AWAY_MS)
      }, ms)
    },
    [place, popBalloon, setLift],
  )

  /**
   * Climb a ladder to a window edge (`ledge`), or down from the one it
   * stands on to the ground (null): the ladder grows, it climbs with the
   * walking steps, the ladder folds away.
   */
  const startLadder = useCallback(
    (ledge: Ledge | null) => {
      const { petWidth: pw, petHeight: ph } = geomRef.current
      const fromY = yRef.current
      const toY = ledge ? ledge.y - ph : groundRef.current
      const ladderX = ledge ? Math.min(Math.max(xRef.current, ledge.x), ledge.x + ledge.width - pw) : xRef.current
      const box = ladderBox(ladderX, fromY, toY, { width: pw, height: ph })
      const up = ledge !== null
      perchBeforeRef.current = perchRef.current
      perchRef.current = null
      targetRef.current = null
      setSitting(false)
      setLift({ kind: 'ladder', phase: 'grow', up, box, ms: LADDER_GROW_MS, ease: EASE_OUT })
      if (ladderX !== xRef.current) place(ladderX, fromY)
      liftTimerRef.current = window.setTimeout(() => {
        const ms = climbMs(toY - fromY)
        setLift({ kind: 'ladder', phase: 'climb', up, box, ms, ease: LINEAR })
        place(ladderX, toY)
        liftTimerRef.current = window.setTimeout(() => {
          if (ledge) {
            // Up: the window may have moved or gone meanwhile.
            const next = followLedge({ id: ledge.id, ledgeX: ledge.x }, xRef.current, ledgesRef.current, { width: pw, height: ph })
            if (!next) {
              startFall()
              return
            }
            perchRef.current = next.perch
            if (next.x !== xRef.current || next.y !== yRef.current) place(next.x, next.y)
          }
          setLift({ kind: 'ladder', phase: 'fold', up, box, ms: 0, ease: LINEAR })
          liftTimerRef.current = window.setTimeout(() => {
            setLift(null)
            setSitting(true)
          }, LADDER_FOLD_MS)
        }, ms)
      }, LADDER_GROW_MS)
    },
    [place, setLift, startFall],
  )

  /** Cut a move short (a bubble came, the menu opened, motion was turned down or it was told to stay put). */
  const abortLift = useCallback(() => {
    const current = liftRef.current
    if (!current) return
    if (current.kind === 'balloon' && current.phase !== 'release') {
      popBalloon()
      return
    }
    if (current.kind === 'fall' || (current.kind === 'ladder' && current.phase === 'climb')) {
      startFall()
      return
    }
    // A ladder still growing or folding, a balloon let go: it is where it should be.
    window.clearTimeout(liftTimerRef.current)
    if (current.kind === 'ladder' && current.phase === 'grow') perchRef.current = perchBeforeRef.current
    setBalloon(null)
    setLift(null)
    setSitting(true)
  }, [popBalloon, startFall, setLift])

  const liftOff = movement === 'still' || reducedMotion
  const liftBlocked = menuOpen || visible !== null || status.needsInput > 0
  useEffect(() => {
    if (!lift) return
    // A fall is never cut short by a bubble: it is over in a moment.
    if (lift.kind === 'fall' && !liftOff) return
    if (liftOff || liftBlocked) abortLift()
  }, [lift, liftOff, liftBlocked, abortLift])

  // Its window moved, shrank or went away: ride along, or fall to the ground.
  useEffect(() => {
    const perch = perchRef.current
    if (!perch) return
    const next = followLedge(perch, xRef.current, allLedges, { width: petWidth, height: petHeight })
    if (!next) {
      startFall()
      return
    }
    perchRef.current = next.perch
    if (next.x === xRef.current && next.y === yRef.current) return
    targetRef.current = null
    xRef.current = next.x
    yRef.current = next.y
    if (petRef.current) petRef.current.style.transform = `translate(${next.x}px, ${next.y}px)`
    setX(next.x)
    setY(next.y)
  }, [allLedges, petWidth, petHeight, startFall])

  /**
   * After a sit: maybe jump onto the nearest window or back down, climb a
   * ladder, or float up on a balloon (chooseLift weighs it); else walk on.
   */
  const afterSit = useCallback(() => {
    if (liftRef.current) return
    const { petWidth: pw, petHeight: ph, width: w, height: h } = geomRef.current
    const choice = chooseLift(
      {
        movement: movementRef.current,
        climb: climbRef.current,
        toys: toysRef.current,
        reducedMotion: reducedMotionRef.current,
        busy: busyRef.current,
        held: heldRef.current || needsInputRef.current > 0,
        perched: perchRef.current !== null,
        x: xRef.current,
        y: yRef.current,
        groundY: groundRef.current,
        ledges: ledgesRef.current,
        pet: { width: pw, height: ph },
        area: { width: w, height: h },
      },
      Math.random,
    )
    if (choice.type === 'jump' && choice.ledge) {
      const { ledge } = choice
      perchRef.current = { id: ledge.id, ledgeX: ledge.x }
      jumpTo(Math.min(Math.max(xRef.current, ledge.x), ledge.x + ledge.width - pw), ledge.y - ph)
    } else if (choice.type === 'jump') {
      perchRef.current = null
      jumpTo(xRef.current, groundRef.current)
    } else if (choice.type === 'ladder') {
      startLadder(choice.ledge)
    } else if (choice.type === 'balloon') {
      startBalloon(choice.plan)
    } else {
      setSitting(false)
    }
  }, [jumpTo, startLadder, startBalloon])

  /** Where it may walk: the edge it stands on, or the whole width. */
  const walkRange = useCallback((): [number, number] => {
    const perch = perchRef.current
    const ledge = perch && ledgesRef.current.find((l) => l.id === perch.id)
    return ledge ? [ledge.x, ledge.x + ledge.width] : [0, window.innerWidth]
  }, [])

  // ── The pointer ─────────────────────────────────────────────────────────
  // When the pointer rests close beside it, it pounces (not when told to
  // stay put). It does not turn to follow the pointer.
  useEffect(() => {
    if (!pointer || walking || dragging) return
    if (movement === 'still' || reducedMotion) return
    if (!withinPounce({ x: xRef.current, y: yRef.current, width: petWidth, height: petHeight }, pointer)) return
    const timer = window.setTimeout(() => setReaction('hop'), POUNCE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [pointer, walking, dragging, movement, reducedMotion, petWidth, petHeight])

  // ── Hit areas ───────────────────────────────────────────────────────────
  const reportFit = useCallback((capture: boolean) => {
    // The pet first (the shell reads the pointer near the first), then what hangs on it.
    const rects = [petRef.current, bubbleRef.current, badgeRef.current, balloonRef.current]
      .filter((el): el is HTMLDivElement | HTMLButtonElement => el !== null)
      .map((el) => {
        const r = el.getBoundingClientRect()
        // A little margin so the edge of the pet is easy to grab.
        return { x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 }
      })
    const key = JSON.stringify([rects.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]), capture])
    if (key === lastFitRef.current) return
    lastFitRef.current = key
    void invoke(FIT_COMMAND, { rects, capture }).catch(() => {})
  }, [])

  useLayoutEffect(() => {
    if (active && x !== null) reportFit(dragging)
  })

  // While it climbs, floats or falls the hit areas follow it (the page does
  // not re-render as the transition moves it).
  const lifting = lift !== null
  useEffect(() => {
    if (!lifting) return
    const timer = window.setInterval(() => reportFit(false), FIT_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [lifting, reportFit])

  // ── Walking ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!walking || !settings) return
    const speed = zooming ? ZOOM_SPEED : WALK_SPEED[settings.movement] * traits.pace
    let frame = 0
    let last = performance.now()
    let lastFit = 0
    const step = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      if (targetRef.current === null) {
        const [lo, hi] = walkRange()
        const pick = zooming ? dashTarget : nextTarget
        targetRef.current = lo + pick(xRef.current - lo, hi - lo, petWidth, Math.random())
        setFacingLeft(targetRef.current < xRef.current)
      }
      const target = targetRef.current
      const delta = target - xRef.current
      const move = Math.sign(delta) * Math.min(Math.abs(delta), speed * dt)
      const [lo, hi] = walkRange()
      xRef.current = lo + clampX(xRef.current + move - lo, hi - lo, petWidth)
      if (petRef.current) petRef.current.style.transform = `translate(${xRef.current}px, ${yRef.current}px)`
      if (t - lastFit > FIT_EVERY_MS) {
        lastFit = t
        reportFit(false)
      }
      if (Math.abs(target - xRef.current) < 0.5) {
        targetRef.current = null
        if (zooming) {
          // Turn and dash again until the bout is over, then pant.
          dashesRef.current -= 1
          if (dashesRef.current > 0) {
            frame = requestAnimationFrame(step)
            return
          }
          setX(xRef.current)
          setZoom('pant')
          return
        }
        setX(xRef.current)
        setSitting(true)
        return
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      setX(xRef.current)
    }
  }, [walking, zooming, settings, traits, petWidth, reportFit, walkRange])

  // Sit a while between walks. While an agent runs it works longer, and
  // folds its laptop away before it sets off.
  useEffect(() => {
    if (!sitting || !settings) return
    const [min, max] = sitPause(settings.movement, busy)
    if (!Number.isFinite(min)) return
    let foldTimer = 0
    const timer = window.setTimeout(() => {
      if (!busyRef.current || heldRef.current || reducedMotionRef.current) {
        afterSit()
        return
      }
      setFold('folding')
      foldTimer = window.setTimeout(() => {
        setFold(null)
        afterSit()
      }, FOLD_MS)
    }, min + Math.random() * (max - min))
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(foldTimer)
      setFold((f) => (f === 'folding' ? null : f))
    }
  }, [sitting, settings, afterSit, busy])

  // Back from a walk with the laptop: set it down and open it.
  const wasCarryingRef = useRef(false)
  useEffect(() => {
    const was = wasCarryingRef.current
    wasCarryingRef.current = carrying
    if (was && !carrying && pose === 'work' && !reducedMotion) setFold('unfolding')
  }, [carrying, pose, reducedMotion])
  useEffect(() => {
    if (fold !== 'unfolding') return
    const timer = window.setTimeout(() => setFold(null), FOLD_MS)
    return () => window.clearTimeout(timer)
  }, [fold])

  // ── Drag and click ──────────────────────────────────────────────────────
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    // Grabbed mid-move, it is held where it is drawn.
    const spot = liftRef.current ? visualSpot() : null
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      petX: spot?.x ?? xRef.current,
      petY: spot?.y ?? yRef.current,
      moved: false,
    }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    if (!drag.moved) {
      drag.moved = true
      perchRef.current = null
      dropLift()
      setDragging(true)
      reportFit(true)
    }
    targetRef.current = null
    xRef.current = clampX(drag.petX + dx, width, petWidth)
    yRef.current = clampY(drag.petY + dy, height, petHeight)
    if (dx !== 0) setFacingLeft(dx < 0)
    setX(xRef.current)
    setY(yRef.current)
  }
  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved) {
      setDragging(false)
      // Dropped in mid-air it falls to the nearest surface below (a window
      // edge or the ground), unless it may not climb: then the height it was
      // dropped at is where it stands from now on. What is saved is the
      // height it stands at once down: the ground, not a window's edge.
      const falls = dropFalls({ movement: movementRef.current, climb: climbRef.current, reducedMotion: reducedMotionRef.current })
      groundRef.current = falls ? Math.max(0, height - petHeight) : yRef.current
      const feet = groundRef.current + petHeight
      reportedRef.current = { x: xRef.current, y: feet, frame: `${width}|${height}|${petWidth}|${petHeight}` }
      void invoke(DRAG_END_COMMAND, { x: xRef.current, y: feet }).catch(() => {})
      if (falls) {
        fallOnPlaceRef.current = true
        startFall()
      } else {
        setSitting(true)
      }
      return
    }
    // A click on the body is only a poke: the pet answers where it is and
    // opens nothing. The badge opens the unread list; a right-click, the menu.
    setSay({ text: traits.voice, at: Date.now() })
    setReaction('hop')
  }

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const unread = bubbles.unread.map(({ id, title }) => ({ id, title }))
    // What waits on you is listed first.
    const questions = bubbles.questions.map(({ id, title }) => ({ id, title }))
    // It stands where it was clicked until the menu closes (the command
    // returns then), and sits a while after.
    setMenuOpen(true)
    void invoke(MENU_COMMAND, { x: event.clientX, y: event.clientY, unread, questions })
      .catch(() => {})
      .finally(() => {
        setMenuOpen(false)
        setSitting(true)
      })
  }

  const open = (bubble: PetBubble) => {
    if (bubble.sessionId) void invoke(OPEN_COMMAND, { notificationId: bubble.id }).catch(() => {})
    // A question stays (folded behind the badge) until it is answered.
    dispatch({ type: 'dismiss', id: bubble.id })
  }

  const dismiss = (bubble: PetBubble) => {
    reportDismissed([bubble])
    dispatch({ type: 'dismiss', id: bubble.id })
  }

  const answer = (bubble: PetBubble, choice: string) => {
    const questionId = bubble.questionId
    if (!questionId || !bubble.sessionId) return
    const key = sessionKey(bubble.sessionId)
    setAnswering((current) => new Map(current).set(bubble.id, 'sending'))
    void invoke(ANSWER_COMMAND, { notificationId: bubble.id, questionId, answers: [[choice]] })
      .then(() => {
        // Taken, or already answered elsewhere: either way it is not waiting.
        dispatch({ type: 'answered', key })
        setAnswering((current) => {
          const next = new Map(current)
          next.delete(bubble.id)
          return next
        })
      })
      .catch((error: unknown) => {
        console.error('pet: answer failed', error)
        setAnswering((current) => new Map(current).set(bubble.id, 'failed'))
      })
  }

  if (!active || !settings || x === null) return null

  const left = walking ? xRef.current : x
  const bubbleX = bubbleLeft(left, width)
  const top = y
  const below = bubbleBelow(top)
  const tailX = `${Math.max(16, left - bubbleX + petWidth / 2 - 6)}px`
  // Above the pet, or below it when it stands too near the top.
  const bubbleStyle = below
    ? { left: bubbleX, top: top + petHeight + 16, ['--tail-x' as string]: tailX }
    : { left: bubbleX, bottom: height - top + 16, ['--tail-x' as string]: tailX }
  const bubbleSide = below ? ' pet-bubble--below' : ''
  const showLaptop = carrying || pose === 'work' || pose === 'alert'
  const laptopFold = !carrying && pose === 'work' ? fold : null
  const laptopClass = carrying ? ' pet-laptop--carried' : laptopFold ? ` pet-laptop--${laptopFold}` : ''
  const petLabel = status.needsInput > 0 ? 'Desktop pet: an agent needs you' : 'Desktop pet'

  return (
    // The browser's own menu (Reload, Inspect) never shows over the pet.
    <div className="pet-strip" onContextMenu={(event) => event.preventDefault()}>
      {/* What the pet is doing, for screen readers: apart from the buttons. */}
      <div className="pet-sr" role="status" aria-live="polite">{status.needsInput > 0 ? petLabel : ''}</div>
      {visible?.type === 'bubble' && (
        <div
          ref={bubbleRef}
          key={visible.bubble.id}
          className={`pet-bubble pet-bubble--${visible.bubble.tone}${bubbleSide}`}
          style={bubbleStyle}
          role="group"
          aria-label={TONE_LABEL[visible.bubble.tone]}
        >
          {/* The words are a live region of their own; the buttons are outside it. */}
          <div className="pet-bubble-text" role="status">
            <span className="pet-chip">
              <ToneMark tone={visible.bubble.tone} />
              {TONE_LABEL[visible.bubble.tone]}
            </span>
            <div className="pet-bubble-title">{visible.bubble.title}</div>
            {visible.bubble.body && <div className="pet-bubble-body">{visible.bubble.body}</div>}
          </div>
          <button
            type="button"
            className="pet-bubble-close"
            aria-label={visible.bubble.tone === 'input' ? 'Later' : 'Dismiss'}
            onClick={() => dismiss(visible.bubble)}
          >
            <X size={14} aria-hidden="true" />
          </button>
          {visible.bubble.sessionId && (
            <div className="pet-bubble-actions">
              {visible.bubble.tone === 'input' && (visible.bubble.questionId ? visible.bubble.choices ?? [] : []).map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  className={index === 0 ? 'pet-button' : 'pet-button pet-button--quiet'}
                  disabled={answering.get(visible.bubble.id) === 'sending'}
                  onClick={() => answer(visible.bubble, choice)}
                >
                  {choice}
                </button>
              ))}
              <button
                type="button"
                className={visible.bubble.tone === 'input' && (visible.bubble.choices ?? []).length > 0 ? 'pet-button pet-button--quiet' : 'pet-button'}
                onClick={() => open(visible.bubble)}
              >
                {visible.bubble.tone === 'input' ? 'Open to answer' : 'Open'}
              </button>
              {answering.get(visible.bubble.id) === 'failed' && <span className="pet-bubble-note" role="alert">Couldn't send. Open to answer.</span>}
            </div>
          )}
        </div>
      )}
      {visible?.type === 'list' && (
        <div
          ref={bubbleRef}
          className={`pet-bubble pet-bubble--list${bubbleSide}`}
          style={bubbleStyle}
          role="group"
          aria-label="Waiting and unread"
        >
          <button type="button" className="pet-bubble-close" aria-label="Close" onClick={() => dispatch({ type: 'toggleList' })}>
            <X size={14} aria-hidden="true" />
          </button>
          {visible.questions.length > 0 && (
            <>
              <div className="pet-bubble-title pet-bubble-title--list">Needs you</div>
              {visible.questions.map((item) => (
                <div key={item.id} className="pet-list-row">
                  <span className={`pet-chip pet-chip--icon pet-bubble--${item.tone}`}>
                    <ToneMark tone={item.tone} />
                  </span>
                  <button type="button" className="pet-list-open" onClick={() => dispatch({ type: 'showQuestion', id: item.id })}>
                    {item.title}
                  </button>
                </div>
              ))}
            </>
          )}
          {visible.unread.length > 0 && (
            <>
              <div className={`pet-bubble-title pet-bubble-title--list${visible.questions.length > 0 ? ' pet-bubble-title--next' : ''}`}>
                {visible.unread.length} unread
              </div>
              {visible.unread.map((item) => (
                <div key={item.id} className="pet-list-row">
                  <span className={`pet-chip pet-chip--icon pet-bubble--${item.tone}`}>
                    <ToneMark tone={item.tone} />
                  </span>
                  <button type="button" className="pet-list-open" onClick={() => open(item)}>
                    {item.title}
                  </button>
                  <button type="button" className="pet-list-dismiss" aria-label={`Dismiss ${item.title}`} onClick={() => dismiss(item)}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {lift?.kind === 'ladder' && (
        <div
          className={`pet-ladder pet-ladder--${lift.up ? 'up' : 'down'}${lift.phase === 'fold' ? ' pet-ladder--fold' : ''}`}
          style={lift.box}
          aria-hidden="true"
        />
      )}
      <div
        ref={petRef}
        className={`pet pet--${pose} pet--${character}${facingLeft && !traits.sideways ? ' pet--left' : ''}${dragging ? ' pet--dragging' : ''}${jumping ? ' pet--jump' : ''}${lift ? ' pet--moving' : ''}${lift?.kind === 'fall' && lift.phase === 'land' ? ' pet--land' : ''}${busy ? ' pet--busy' : ''}${laptopFold ? ` pet--${laptopFold}` : ''}`}
        style={{
          width: petWidth,
          height: petHeight,
          transform: `translate(${left}px, ${top}px)`,
          ...(lift ? { ['--pet-move-ms' as string]: `${lift.ms}ms`, ['--pet-move-ease' as string]: lift.ease } : {}),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
      >
        {badge > 0 && (
          <button
            ref={badgeRef}
            type="button"
            className="pet-badge"
            data-needs-you={bubbles.questions.length > 0 ? '' : undefined}
            aria-label={badgeText}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => dispatch({ type: 'toggleList' })}
          >
            {badge}
          </button>
        )}
        {say && (
          <span key={say.at} className="pet-say" aria-live="polite">
            {say.text}
          </span>
        )}
        {pose === 'alert' && <span className="pet-mark pet-mark--alert">!</span>}
        {pose === 'look' && <span className="pet-mark pet-mark--look">♪</span>}
        {pose === 'pant' && <span className="pet-mark pet-mark--pant">~</span>}
        {pose === 'sleep' && <span className="pet-zzz">z z</span>}
        {balloon === 'float' && (
          <button
            ref={balloonRef}
            type="button"
            className="pet-balloon"
            aria-label="Pop the balloon"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={popBalloon}
          >
            <BalloonArt popped={false} />
          </button>
        )}
        {(balloon === 'pop' || balloon === 'away') && (
          <span className={`pet-balloon pet-balloon--${balloon}`} aria-hidden="true">
            <BalloonArt popped={balloon === 'pop'} />
          </span>
        )}
        <div className="pet-body" role="img" aria-label={petLabel}>
          <Sprite character={character} pose={pose} colour={settings.colour} />
        </div>
        {showLaptop && (
          <span className={`pet-laptop${laptopClass}`} aria-hidden="true">
            <i />
            <b />
            <span className="pet-laptop-puff" />
            <span className="pet-laptop-spark">✦</span>
          </span>
        )}
      </div>
      {dust && (
        <span key={dust.at} className="pet-dust" style={{ left: dust.x, top: dust.y }} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  )
}

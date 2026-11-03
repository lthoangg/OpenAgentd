import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlarmClock, Check, CircleAlert, MessageCircleQuestion, X } from 'lucide-react'

import { poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from './sprites'
import {
  BUBBLE_ROOM,
  BUBBLE_WIDTH,
  BUBBLE_FADE_MS,
  CHARACTER_TRAITS,
  DUST_MS,
  EMPTY_BUBBLES,
  FOLD_MS,
  FRAME_SETTLE_MS,
  FRAME_SHRINK_AFTER_MS,
  FRAME_WAIT_MS,
  JUMP_CROUCH_MS,
  JUMP_LOOK_MS,
  JUMP_STEPS,
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
  followLedge,
  frameCovers,
  growFrame,
  jumpMs,
  jumpPath,
  jumpReach,
  ladderBox,
  liftsAllowed,
  neededFrame,
  originMoves,
  readOnDismiss,
  ledges,
  nextTarget,
  petPose,
  reactionFor,
  sitPause,
  shrinkable,
  startX,
  startY,
  toArea,
  visibleBubble,
  withinPounce,
  zoomDelay,
  zoomsWhenDone,
  type Box,
  type BubbleTone,
  type Ledge,
  type PetBubble,
  type PetCharacter,
  type PetColour,
  type PetFrameView,
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
/** The window's frame changed: the work area and the window's box in it. */
const FRAME_EVENT = 'pet-frame'
/** A press that moves less than this is a click, not a drag. */
const DRAG_SLOP = 4
const REACTION_MS: Record<PetReaction, number> = { hop: 1700, droop: 2500, look: 2000 }
/** How often the hit areas are re-sent while the pet walks. */
const FIT_EVERY_MS = 100
/** How long the pet's reply to a poke stays up. */
const POKE_SAY_MS = 2500

type MenuAction = { action: 'dismiss'; id: string } | { action: 'clear' }

/** Dismissed finished turns and reminders: their sessions are read everywhere. */
function reportDismissed(items: PetBubble[]): void {
  const notificationIds = readOnDismiss(items)
  if (notificationIds.length > 0) void invoke(DISMISS_COMMAND, { notificationIds }).catch(() => {})
}
type PointerAt = { x: number; y: number } | null
/** The laptop being folded before a walk, or opened after one. */
type Fold = 'folding' | 'unfolding'

/**
 * A ladder or a fall under way. `ms` and `ease` are how the pet's
 * move to its new place goes (CSS does the moving: one transition on the
 * pet, no per-frame work in the page).
 */
type Lift = { ms: number; ease: string } & (
  | { kind: 'ladder'; phase: 'grow' | 'climb' | 'fold'; up: boolean; box: { left: number; top: number; width: number; height: number } }
  | { kind: 'fall'; phase: 'fall' | 'land' }
)

/** The pose of a move: it sits while a ladder grows or folds, and after a landing. */
function liftPose(lift: Lift | null): 'sit' | 'climb' | 'fall' | null {
  if (!lift) return null
  if (lift.kind === 'ladder') return lift.phase === 'climb' ? 'climb' : 'sit'
  return lift.phase === 'fall' ? 'fall' : 'sit'
}

/** The steps of a jump: look toward the target, crouch, leap along an arc, land. */
type JumpPhase = 'look' | 'crouch' | 'leap' | 'land'

const LINEAR = 'var(--ease-linear)'
const EASE_OUT = 'var(--ease-out)'

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

/** What a bubble says: its state, title and body. */
function BubbleWords({ bubble }: { bubble: PetBubble }) {
  return (
    <>
      <span className="pet-chip">
        <ToneMark tone={bubble.tone} />
        {TONE_LABEL[bubble.tone]}
      </span>
      <span className="pet-bubble-title">{bubble.title}</span>
      {bubble.body && <span className="pet-bubble-body">{bubble.body}</span>}
    </>
  )
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
  // The pet lives in the work area (the shell says how big it is), drawn
  // through a window that is only a lane of it. Without that (older shell, or
  // before the window is placed) the window is the whole world.
  const [windowSize, setWindowSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [frameView, setFrameView] = useState<PetFrameView | null>(null)
  /** The lane is moving: the pet is hidden until the webview has redrawn at the new size. */
  const [shifting, setShifting] = useState(false)
  /** The page stays put on screen and the window is a viewport over it (PetFrameView.fixed). */
  const [fixed, setFixed] = useState(false)
  const width = frameView?.area.width ?? windowSize.width
  const height = frameView?.area.height ?? windowSize.height
  const frame: Box = frameView?.frame ?? { x: 0, y: 0, width, height }
  const [x, setX] = useState<number | null>(null)
  const [y, setY] = useState(0)
  const [facingLeft, setFacingLeft] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [zoom, setZoom] = useState<ZoomPhase | null>(null)
  const [pointer, setPointer] = useState<PointerAt>(null)
  const [windows, setWindows] = useState<OtherWindow[]>([])
  /** Where a jump is: looking, crouching, in the air or landing; null when it is not jumping. */
  const [jumpPhase, setJumpPhase] = useState<JumpPhase | null>(null)
  /** Whether the jump goes down (it leans forward, not up). */
  const [jumpDown, setJumpDown] = useState(false)
  const jumping = jumpPhase !== null
  const [lift, setLiftState] = useState<Lift | null>(null)
  const [dust, setDust] = useState<{ x: number; y: number; at: number } | null>(null)
  const [say, setSay] = useState<{ text: string; at: number } | null>(null)
  const [fold, setFold] = useState<Fold | null>(null)
  const reducedMotion = useReducedMotion()

  const petRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const xRef = useRef(0)
  /** The height it stands at on the ground (where it was placed or dropped). */
  const groundRef = useRef(0)
  /** The window it stands on, if any. */
  const perchRef = useRef<Perch | null>(null)
  /** The timer of the next phase of the jump under way. */
  const jumpTimerRef = useRef(0)
  /** The leap's animation while it runs (the Web Animations API moves the pet along the arc). */
  const jumpAnimRef = useRef<Animation | null>(null)
  const liftRef = useRef<Lift | null>(null)
  /** Stop a jump's timers and its leap; the caller says where the pet is (or clears the phase). */
  const stopJump = useCallback(() => {
    window.clearTimeout(jumpTimerRef.current)
    jumpAnimRef.current?.cancel()
    jumpAnimRef.current = null
  }, [])
  /** The timer of the next step of the ladder or fall under way. */
  const liftTimerRef = useRef(0)
  const dustTimerRef = useRef(0)
  /** The window it stood on when a ladder started down: put back if the ladder is called off. */
  const perchBeforeRef = useRef<Perch | null>(null)
  /** A drop is waiting for the pet to be placed before it falls (dropped over another display). */
  const fallOnPlaceRef = useRef(false)
  /** Where the page last told the shell the pet was dropped, to tell the shell's echo from a move. */
  const reportedRef = useRef<{ x: number; y: number; frame: string } | null>(null)
  const startFallRef = useRef<() => void>(() => {})
  /** The window's box in the area, as last told by the shell: the offset the page draws at. */
  const frameRef = useRef<Box>({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
  const fixedRef = useRef(false)
  /** Where the page's (0, 0) is in the area: the window's corner, or the area's own with a fixed page. */
  const drawOrigin = useCallback((): { x: number; y: number } => (fixedRef.current ? { x: 0, y: 0 } : frameRef.current), [])
  /** The frame last asked for (a bigger one is kept a while before it shrinks). */
  const wantRef = useRef<Box | null>(null)
  /** The pet's whole path in a move under way, or null: the window must hold all of it. */
  const reachRef = useRef<Box | null>(null)
  const managedRef = useRef(false)
  const shiftingRef = useRef(false)
  const shiftTimerRef = useRef(0)
  const shrinkTimerRef = useRef(0)
  const waitTimerRef = useRef(0)
  /** A move waiting for the window to have the room it needs. */
  const pendingRef = useRef<(() => void) | null>(null)
  const flushPendingRef = useRef<() => void>(() => {})
  const lastAreaRef = useRef<{ width: number; height: number } | null>(null)
  /** The frame the pet was last hidden for: a shell that never answers does not hide it again and again. */
  const hiddenForRef = useRef('')
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
  /** The shell placed or moved the window: draw at its offset, and show the pet again once it has settled. */
  const adoptFrame = useCallback((next: PetFrameView) => {
    const sameArea = lastAreaRef.current?.width === next.area.width && lastAreaRef.current.height === next.area.height
    lastAreaRef.current = next.area
    frameRef.current = next.frame
    fixedRef.current = Boolean(next.fixed)
    setFixed(fixedRef.current)
    hiddenForRef.current = ''
    managedRef.current = true
    // Another display: the frame asked for was in the old one's pixels.
    if (!sameArea) wantRef.current = null
    setFrameView((current) => {
      const same =
        current &&
        current.area.width === next.area.width &&
        current.area.height === next.area.height &&
        ['x', 'y', 'width', 'height'].every((k) => current.frame[k as keyof Box] === next.frame[k as keyof Box])
      return same ? current : next
    })
    const want = wantRef.current
    if (!shiftingRef.current) {
      // The room a move waits for came without the corner moving.
      if (pendingRef.current && (!want || frameCovers(next.frame, want))) flushPendingRef.current()
      return
    }
    // The shell's answer to an older request (or none of ours): keep waiting.
    if (want && originMoves(next.frame, want)) return
    window.clearTimeout(shiftTimerRef.current)
    shiftTimerRef.current = window.setTimeout(() => {
      shiftingRef.current = false
      setShifting(false)
      flushPendingRef.current()
    }, FRAME_SETTLE_MS)
  }, [])

  const applyView = useCallback((next: PetView) => {
    if (next.area && next.frame) adoptFrame({ area: next.area, frame: next.frame, fixed: next.fixed })
    setView(next)
    dispatch({ type: 'status', status: next.status })
    if (next.status.running > 0 || next.status.needsInput > 0) setLastActivity(Date.now())
    if (!next.settings.enabled) dispatch({ type: 'clear' })
  }, [adoptFrame])

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
  useShellEvent<PetFrameView>(
    FRAME_EVENT,
    useCallback(
      (next: PetFrameView) => {
        if (next?.area && next.frame) adoptFrame(next)
      },
      [adoptFrame],
    ),
  )

  useEffect(() => {
    const onResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight })
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
    stopJump()
    setJumpPhase(null)
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
  }, [ready, savedFraction, savedHeight, savedDisplay, width, height, petWidth, petHeight, stopJump])

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

  // ── The window's frame ──────────────────────────────────────────────────
  // The window is a lane of the work area, as tall as the scene needs: the
  // page asks for it with the hit areas (`pet_fit`), the shell moves the
  // window and says where it is (`pet-frame`). Everything the page keeps is
  // in area pixels; only the drawing is offset by the window's origin. A
  // bigger lane than needed is kept until the pet has been still for a
  // while, and a move that needs more room waits for it.
  const geomRef = useRef({ petWidth, petHeight, width, height })
  geomRef.current = { petWidth, petHeight, width, height }
  const walkingRef = useRef(false)
  walkingRef.current = walking
  const jumpingRef = useRef(false)
  jumpingRef.current = jumping
  const draggingRef = useRef(false)
  draggingRef.current = dragging
  const tryShrinkRef = useRef<() => void>(() => {})

  /** What the window needs now, in area pixels. */
  const currentNeed = useCallback((capture: boolean): Box => {
    const { petWidth: pw, petHeight: ph, width: w, height: h } = geomRef.current
    const top = yRef.current
    const rects: Box[] = []
    const bubble = bubbleRef.current
    if (bubble) {
      // Over the pet, or under it near the top; room for its tail and shadow.
      const bubbleHeight = bubble.offsetHeight || BUBBLE_ROOM
      const below = bubbleBelow(top)
      rects.push({
        x: bubbleLeft(xRef.current, w) - 24,
        y: (below ? top + ph + 16 : top - 16 - bubbleHeight) - 24,
        width: BUBBLE_WIDTH + 48,
        height: bubbleHeight + 48,
      })
    }
    const current = liftRef.current
    if (current?.kind === 'ladder') rects.push({ x: current.box.left, y: current.box.top, width: current.box.width, height: current.box.height })
    return neededFrame({ area: { width: w, height: h }, pet: { x: xRef.current, y: top, width: pw, height: ph }, reach: reachRef.current, rects, dragging: capture })
  }, [])

  const scheduleShrink = useCallback(() => {
    if (shrinkTimerRef.current) return
    shrinkTimerRef.current = window.setTimeout(() => {
      shrinkTimerRef.current = 0
      tryShrinkRef.current()
    }, FRAME_SHRINK_AFTER_MS)
  }, [])

  /** Tell the shell where the pet can be clicked (area pixels), and the lane it needs. */
  const reportFit = useCallback(
    (capture: boolean) => {
      const origin = drawOrigin()
      // The pet first (the shell reads the pointer near the first), then what hangs on it.
      const rects = [petRef.current, bubbleRef.current, badgeRef.current]
        .filter((el): el is HTMLDivElement | HTMLButtonElement => el !== null)
        .map((el) => {
          const r = el.getBoundingClientRect()
          const box = toArea({ x: r.left, y: r.top, width: r.width, height: r.height }, origin)
          // A little margin so the edge of the pet is easy to grab.
          return { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 }
        })
      let want: Box | undefined
      if (managedRef.current) {
        const need = currentNeed(capture)
        let next = wantRef.current ?? frameRef.current
        if (!frameCovers(next, need)) next = growFrame(next, need)
        else if (shrinkable(next, need)) scheduleShrink()
        wantRef.current = want = next
        // Its top-left corner moves: hide the pet until the webview has redrawn
        // there. A fixed page does not move with the window: nothing to hide.
        if (!fixedRef.current && !shiftingRef.current && originMoves(frameRef.current, next) && hiddenForRef.current !== JSON.stringify(next)) {
          hiddenForRef.current = JSON.stringify(next)
          shiftingRef.current = true
          setShifting(true)
          window.clearTimeout(shiftTimerRef.current)
          shiftTimerRef.current = window.setTimeout(() => {
            shiftingRef.current = false
            setShifting(false)
            flushPendingRef.current()
          }, FRAME_WAIT_MS)
        }
      }
      const round = (b: Box) => [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]
      const key = JSON.stringify([rects.map(round), capture, want ? round(want) : null])
      if (key === lastFitRef.current) return
      lastFitRef.current = key
      void invoke(FIT_COMMAND, { rects, capture, frame: want }).catch(() => {})
    },
    [currentNeed, drawOrigin, scheduleShrink],
  )

  // Still for a while: the lane shrinks to what the pet needs now.
  tryShrinkRef.current = () => {
    const quiet = !walkingRef.current && !jumpingRef.current && !draggingRef.current && liftRef.current === null
    if (!quiet) {
      scheduleShrink()
      return
    }
    const want = wantRef.current
    const need = currentNeed(false)
    if (want && shrinkable(want, need)) {
      wantRef.current = need
      reportFit(false)
    }
  }

  flushPendingRef.current = () => {
    window.clearTimeout(waitTimerRef.current)
    const go = pendingRef.current
    pendingRef.current = null
    go?.()
  }

  /**
   * Start a move once the window holds all of its path (`reach`): ask for
   * the room, and go at once if it is there, else when the shell has made it
   * (or after a short wait). Without a shell frame it goes at once.
   */
  const needFrame = useCallback(
    (reach: Box, go: () => void) => {
      reachRef.current = reach
      if (!managedRef.current) {
        go()
        return
      }
      reportFit(draggingRef.current)
      if (!shiftingRef.current && frameCovers(frameRef.current, wantRef.current ?? frameRef.current)) {
        go()
        return
      }
      pendingRef.current = go
      window.clearTimeout(waitTimerRef.current)
      waitTimerRef.current = window.setTimeout(() => flushPendingRef.current(), FRAME_WAIT_MS)
    },
    [reportFit],
  )
  useEffect(
    () => () => {
      window.clearTimeout(shiftTimerRef.current)
      window.clearTimeout(shrinkTimerRef.current)
      window.clearTimeout(waitTimerRef.current)
    },
    [],
  )

  // ── Climbing on windows ─────────────────────────────────────────────────
  const allLedges = useMemo(() => ledges(windows, { width, height }, { width: petWidth, height: petHeight }), [windows, width, height, petWidth, petHeight])
  const ledgesRef = useRef(allLedges)
  ledgesRef.current = allLedges
  const movement = settings?.movement ?? 'calm'

  // ── Ladders and falls ───────────────────────────────────────────────────
  // Each is a short chain of timers (a phase per step) that changes the
  // pet's target and lets one CSS transition do the moving.
  const climbRef = useRef(false)
  climbRef.current = Boolean(settings?.climb)
  const toysRef = useRef(true)
  toysRef.current = settings?.toys ?? true
  const needsInputRef = useRef(0)
  needsInputRef.current = status.needsInput

  const setLift = useCallback((next: Lift | null) => {
    liftRef.current = next
    if (next === null) reachRef.current = null
    setLiftState(next)
  }, [])

  const place = useCallback((nextX: number, nextY: number) => {
    targetRef.current = null
    xRef.current = nextX
    yRef.current = nextY
    setX(nextX)
    setY(nextY)
  }, [])

  /** Where the pet is drawn now, mid-move, in area pixels; null when it cannot be measured. */
  const visualSpot = useCallback((): { x: number; y: number } | null => {
    const rect = petRef.current?.getBoundingClientRect()
    const origin = drawOrigin()
    return rect && rect.width > 0 ? { x: rect.left + origin.x, y: rect.top + origin.y } : null
  }, [drawOrigin])

  /** Stop whatever is under way where it stands, without a fall. */
  const dropLift = useCallback(() => {
    window.clearTimeout(liftTimerRef.current)
    window.clearTimeout(dustTimerRef.current)
    fallOnPlaceRef.current = false
    // A jump under way ends where it is drawn (the drag or the fall takes over from there).
    stopJump()
    setJumpPhase(null)
    setLift(null)
    setDust(null)
  }, [setLift, stopJump])
  useEffect(
    () => () => {
      window.clearTimeout(liftTimerRef.current)
      window.clearTimeout(dustTimerRef.current)
    },
    [],
  )

  /**
   * Fall to the nearest surface below (a window edge it is over, or the
   * ground): gravity, a squash on landing and a puff of dust. With motion
   * reduced or told to stay put it is just there. It falls once the window
   * reaches down to where it lands.
   */
  const startFall = useCallback(() => {
    window.clearTimeout(liftTimerRef.current)
    // A jump still landing gives way to the fall.
    stopJump()
    setJumpPhase(null)
    const { petWidth: pw, petHeight: ph } = geomRef.current
    // Mid-move it falls from where it is drawn now.
    const spot = liftRef.current ? visualSpot() : null
    if (spot) {
      xRef.current = spot.x
      yRef.current = spot.y
    }
    const target = fallTarget({ x: xRef.current, y: yRef.current }, climbRef.current ? ledgesRef.current : [], groundRef.current, { width: pw, height: ph })
    const distance = target.y - yRef.current
    const done = () => {
      fallOnPlaceRef.current = false
      setLift(null)
      setSitting(true)
    }
    const fall = () => {
      perchRef.current = target.ledge ? { id: target.ledge.id, ledgeX: target.ledge.x } : null
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
    }
    needFrame({ x: target.x, y: Math.min(yRef.current, target.y), width: pw, height: Math.abs(distance) + ph }, fall)
  }, [needFrame, place, setLift, stopJump, visualSpot])
  startFallRef.current = startFall

  /**
   * Jump to `nextX`, with its top `nextY` (the edge of the window `perch`, or
   * the ground), like a cat: it looks toward where it is going, crouches,
   * leaps along an arc (the Web Animations API moves it, one animation, no
   * per-frame work in the page) and lands with the fall's squash and a puff
   * of dust. Up it clears the window by most of a pet's height; down it
   * hops up a little first. It stays "jumping" (held) through all of it.
   */
  const jumpTo = useCallback(
    (nextX: number, nextY: number, perch: Perch | null) => {
      const { petWidth: pw, petHeight: ph } = geomRef.current
      targetRef.current = null
      stopJump()
      const down = nextY > yRef.current
      if (Math.abs(nextX - xRef.current) > 1) setFacingLeft(nextX < xRef.current)
      setJumpDown(down)
      setJumpPhase('look')
      const next = (ms: number, then: () => void) => {
        window.clearTimeout(jumpTimerRef.current)
        jumpTimerRef.current = window.setTimeout(then, ms)
      }
      const finish = () => {
        setJumpPhase(null)
        setSitting(false)
        reachRef.current = null
      }
      const land = () => {
        const el = petRef.current
        // Leave the pet at its place, not under an animation, so later moves work.
        if (el) el.style.transform = `translate(${nextX}px, ${nextY}px)`
        jumpAnimRef.current?.cancel()
        jumpAnimRef.current = null
        if (perch) {
          // Up: the window may have moved or gone while it was in the air.
          const onto = followLedge(perch, nextX, ledgesRef.current, { width: pw, height: ph })
          if (!onto) {
            setJumpPhase(null)
            startFallRef.current()
            return
          }
          perchRef.current = onto.perch
          if (onto.x !== nextX || onto.y !== nextY) {
            place(onto.x, onto.y)
            if (el) el.style.transform = `translate(${onto.x}px, ${onto.y}px)`
          }
        }
        setJumpPhase('land')
        window.clearTimeout(dustTimerRef.current)
        setDust({ x: xRef.current + pw / 2, y: yRef.current + ph, at: Date.now() })
        dustTimerRef.current = window.setTimeout(() => setDust(null), DUST_MS)
        next(LAND_MS, finish)
      }
      const leap = () => {
        const from = { x: xRef.current, y: yRef.current }
        const to = { x: nextX, y: nextY }
        const ms = jumpMs(Math.hypot(to.x - from.x, to.y - from.y))
        perchRef.current = null
        // The page now stands at the end; the leap draws the way there.
        place(nextX, nextY)
        setJumpPhase('leap')
        const el = petRef.current
        if (el && typeof el.animate === 'function') {
          const frames = jumpPath(from, to, { height: ph }, JUMP_STEPS).map((p) => ({ transform: `translate(${p.x}px, ${p.y}px)` }))
          const anim = el.animate(frames, { duration: ms, easing: 'linear', fill: 'forwards' })
          // Cancelling it later rejects its `finished` promise: nobody waits on that.
          anim.finished?.catch(() => {})
          jumpAnimRef.current = anim
        }
        next(ms, land)
      }
      next(JUMP_LOOK_MS, () => {
        setJumpPhase('crouch')
        next(JUMP_CROUCH_MS, leap)
      })
    },
    [place, stopJump],
  )
  useEffect(() => stopJump, [stopJump])

  /** It may still start something: no bubble, menu or question came while it waited for room. */
  const mayStart = useCallback(
    () => liftsAllowed({ movement: movementRef.current, reducedMotion: reducedMotionRef.current, held: heldRef.current || needsInputRef.current > 0 }),
    [],
  )
  /** What it waited for no longer applies: walk on. */
  const abandon = useCallback(() => {
    reachRef.current = null
    setSitting(false)
  }, [])

  /**
   * Climb a ladder to a window edge (`ledge`), or down from the one it
   * stands on to the ground (null): the ladder grows, it climbs with the
   * walking steps, the ladder folds away. The window must hold the whole
   * ladder before it grows.
   */
  const startLadder = useCallback(
    (ledge: Ledge | null) => {
      const { petWidth: pw, petHeight: ph } = geomRef.current
      const fromY = yRef.current
      const toY = ledge ? ledge.y - ph : groundRef.current
      const ladderX = ledge ? Math.min(Math.max(xRef.current, ledge.x), ledge.x + ledge.width - pw) : xRef.current
      const box = ladderBox(ladderX, fromY, toY, { width: pw, height: ph })
      const up = ledge !== null
      const reach: Box = { x: ladderX, y: Math.min(fromY, toY), width: pw, height: Math.abs(toY - fromY) + ph }
      const grow = () => {
        perchBeforeRef.current = perchRef.current
        perchRef.current = null
        targetRef.current = null
        setSitting(false)
        setLift({ kind: 'ladder', phase: 'grow', up, box, ms: LADDER_GROW_MS, ease: EASE_OUT })
        reachRef.current = reach
        if (ladderX !== xRef.current) place(ladderX, fromY)
        liftTimerRef.current = window.setTimeout(() => {
          const ms = climbMs(toY - fromY)
          setLift({ kind: 'ladder', phase: 'climb', up, box, ms, ease: LINEAR })
          reachRef.current = reach
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
      }
      needFrame(reach, () => (mayStart() ? grow() : abandon()))
    },
    [abandon, mayStart, needFrame, place, setLift, startFall],
  )

  /** Cut a move short (a bubble came, the menu opened, motion was turned down or it was told to stay put). */
  const abortLift = useCallback(() => {
    const current = liftRef.current
    if (!current) return
    if (current.kind === 'fall' || (current.kind === 'ladder' && current.phase === 'climb')) {
      startFall()
      return
    }
    // A ladder still growing or folding: it is where it should be.
    window.clearTimeout(liftTimerRef.current)
    if (current.kind === 'ladder' && current.phase === 'grow') perchRef.current = perchBeforeRef.current
    setLift(null)
    setSitting(true)
  }, [startFall, setLift])

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
    // A jump settles on its window itself when it lands; this runs again then.
    if (!perch || (jumpPhase !== null && jumpPhase !== 'land')) return
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
  }, [allLedges, petWidth, petHeight, startFall, jumpPhase])

  /**
   * After a sit: maybe jump onto the nearest window or back down, climb a
   * ladder (chooseLift weighs it); else walk on.
   * A move that needs more of the screen waits for the window to reach it.
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
    const hop = (toX: number, toY: number, perch: Perch | null) => {
      // The window must hold the whole arc, its highest point too.
      const reach = jumpReach({ x: xRef.current, y: yRef.current }, { x: toX, y: toY }, { width: pw, height: ph })
      needFrame(reach, () => {
        if (!mayStart()) {
          abandon()
          return
        }
        jumpTo(toX, toY, perch)
      })
    }
    if (choice.type === 'jump' && choice.ledge) {
      const { ledge } = choice
      hop(Math.min(Math.max(xRef.current, ledge.x), ledge.x + ledge.width - pw), ledge.y - ph, { id: ledge.id, ledgeX: ledge.x })
    } else if (choice.type === 'jump') {
      hop(xRef.current, groundRef.current, null)
    } else if (choice.type === 'ladder') {
      startLadder(choice.ledge)
    } else {
      setSitting(false)
    }
  }, [abandon, jumpTo, mayStart, needFrame, startLadder])

  /** Where it may walk: the edge it stands on, or the whole width. */
  const walkRange = useCallback((): [number, number] => {
    const perch = perchRef.current
    const ledge = perch && ledgesRef.current.find((l) => l.id === perch.id)
    return ledge ? [ledge.x, ledge.x + ledge.width] : [0, geomRef.current.width]
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
  useLayoutEffect(() => {
    if (active && x !== null) reportFit(dragging)
  })

  // While it climbs, jumps or falls the hit areas follow it (the page does
  // not re-render as the transition or the leap moves it).
  const lifting = lift !== null || jumping
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
    const spot = liftRef.current || jumpingRef.current ? visualSpot() : null
    dragRef.current = {
      // In area pixels: the window's frame may change under a drag.
      startX: event.clientX + drawOrigin().x,
      startY: event.clientY + drawOrigin().y,
      petX: spot?.x ?? xRef.current,
      petY: spot?.y ?? yRef.current,
      moved: false,
    }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX + drawOrigin().x - drag.startX
    const dy = event.clientY + drawOrigin().y - drag.startY
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
    // The menu opens at a point in the window, which a fixed page is not drawn from.
    const origin = drawOrigin()
    const at = { x: event.clientX + origin.x - frameRef.current.x, y: event.clientY + origin.y - frameRef.current.y }
    void invoke(MENU_COMMAND, { ...at, unread, questions })
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
    <div
      className={`pet-strip${shifting ? ' pet-strip--shifting' : ''}`}
      // A fixed page already lies on the work area; else it is drawn offset by the window's corner.
      style={{ left: fixed ? 0 : -frame.x, top: fixed ? 0 : -frame.y, width, height }}
      onContextMenu={(event) => event.preventDefault()}
    >
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
            <BubbleWords bubble={visible.bubble} />
          </div>
          {/* A bubble only tells: a click anywhere on it opens the session, where
            * the details (and any answer) are. Later sits above it. */}
          {visible.bubble.sessionId && (
            <button
              type="button"
              className="pet-bubble-open"
              aria-label={`Open ${visible.bubble.title}`}
              onClick={() => open(visible.bubble)}
            />
          )}
          <button
            type="button"
            className="pet-bubble-close"
            aria-label={visible.bubble.tone === 'input' ? 'Later' : 'Dismiss'}
            onClick={() => dismiss(visible.bubble)}
          >
            <X size={14} aria-hidden="true" />
          </button>
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
        className={`pet pet--${pose} pet--${character}${facingLeft && !traits.sideways ? ' pet--left' : ''}${dragging ? ' pet--dragging' : ''}${jumpPhase && jumpPhase !== 'land' ? ` pet--jump-${jumpPhase}` : ''}${jumpPhase === 'look' && jumpDown ? ' pet--jump-down' : ''}${lift ? ' pet--moving' : ''}${(lift?.kind === 'fall' && lift.phase === 'land') || jumpPhase === 'land' ? ' pet--land' : ''}${busy ? ' pet--busy' : ''}${laptopFold ? ` pet--${laptopFold}` : ''}`}
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

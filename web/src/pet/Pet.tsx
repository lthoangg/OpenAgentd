import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlarmClock, Check, CircleAlert, MessageCircleQuestion, X } from 'lucide-react'

import { poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from './sprites'
import {
  BUBBLE_FADE_MS,
  CHARACTER_TRAITS,
  CLIMB_CHANCE,
  EMPTY_BUBBLES,
  JUMP_DOWN_CHANCE,
  JUMP_MS,
  PANT_MS,
  PET_HEIGHT,
  PET_WIDTH,
  POUNCE_AFTER_MS,
  SIT_PAUSE,
  SIZE_SCALE,
  WALK_SPEED,
  ZOOM_DASHES,
  ZOOM_SPEED,
  badgeCount,
  bubbleBelow,
  bubbleLeft,
  bubbleReducer,
  clampX,
  clampY,
  dashTarget,
  followLedge,
  ledges,
  nextTarget,
  petPose,
  reactionFor,
  startX,
  startY,
  visibleBubble,
  withinPounce,
  zoomDelay,
  zoomsWhenDone,
  type BubbleTone,
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
const DRAG_END_COMMAND = 'pet_drag_end'
const MENU_COMMAND = 'pet_menu'
const STATE_EVENT = 'pet-state'
const NOTIFICATION_EVENT = 'pet-notification'
const MENU_EVENT = 'pet-menu-action'
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
type PointerAt = { x: number; y: number } | null

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
  input: 'Needs your answer',
  done: 'Finished',
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
  const [say, setSay] = useState<{ text: string; at: number } | null>(null)
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
  const scale = settings ? SIZE_SCALE[settings.size] : 1
  const petWidth = PET_WIDTH * scale
  const petHeight = PET_HEIGHT * scale
  const visible = visibleBubble(bubbles)
  const badge = badgeCount(bubbles)
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
      else dispatch({ type: 'clearUnread' })
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
    const start = startX(saved, width, petWidth)
    xRef.current = start
    yRef.current = startY(saved, height, petHeight)
    groundRef.current = yRef.current
    perchRef.current = null
    targetRef.current = null
    setX(start)
    setY(yRef.current)
  }, [ready, savedFraction, savedHeight, savedDisplay, width, height, petWidth, petHeight])

  const held = dragging || menuOpen || jumping || visible !== null
  const pose = petPose({
    status,
    reaction,
    sitting,
    held,
    zoom,
    idleMs: now - lastActivity,
    reducedMotion,
    movement: settings?.movement ?? 'calm',
  })
  const zooming = pose === 'zoom'
  const walking = active && (pose === 'walk' || zooming)

  // ── Zoomies ─────────────────────────────────────────────────────────────
  const startZoom = useCallback(() => {
    zoomPendingRef.current = false
    dashesRef.current = ZOOM_DASHES
    targetRef.current = null
    setSitting(false)
    setZoom('run')
  }, [])

  // Now and then on its own (chaotic only).
  useEffect(() => {
    if (!settings || zoom !== null || reducedMotion) return
    const delay = zoomDelay(settings.movement, Math.random())
    if (delay === null) return
    const timer = window.setTimeout(startZoom, delay)
    return () => window.clearTimeout(timer)
  }, [settings, zoom, reducedMotion, startZoom])

  // After a finished turn, once its bubble and hop are over.
  useEffect(() => {
    if (!zoomPendingRef.current || !active || zoom !== null || held || reaction) return
    if (reducedMotion || !zoomsWhenDone(settings?.movement ?? 'calm')) {
      zoomPendingRef.current = false
      return
    }
    startZoom()
  }, [active, zoom, held, reaction, reducedMotion, settings?.movement, startZoom])

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
  const mayClimb = Boolean(settings?.climb) && (movement === 'playful' || movement === 'chaotic') && !reducedMotion

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

  // Its window moved, shrank or went away: ride along, or fall to the ground.
  useEffect(() => {
    const perch = perchRef.current
    if (!perch) return
    const next = followLedge(perch, xRef.current, allLedges, { width: petWidth, height: petHeight })
    if (!next) {
      perchRef.current = null
      jumpTo(xRef.current, groundRef.current)
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
  }, [allLedges, petWidth, petHeight, jumpTo])

  /** After a sit: maybe jump onto the nearest window, or back down; else walk on. */
  const afterSit = useCallback(() => {
    if (mayClimb) {
      if (perchRef.current && Math.random() < JUMP_DOWN_CHANCE) {
        perchRef.current = null
        jumpTo(xRef.current, groundRef.current)
        return
      }
      const choices = ledgesRef.current
      if (!perchRef.current && choices.length > 0 && Math.random() < CLIMB_CHANCE) {
        const centre = (l: { x: number; width: number }) => Math.abs(l.x + l.width / 2 - xRef.current)
        const ledge = choices.reduce((best, l) => (centre(l) < centre(best) ? l : best))
        perchRef.current = { id: ledge.id, ledgeX: ledge.x }
        jumpTo(Math.min(Math.max(xRef.current, ledge.x), ledge.x + ledge.width - petWidth), ledge.y - petHeight)
        return
      }
    }
    setSitting(false)
  }, [mayClimb, jumpTo, petWidth, petHeight])

  /** Where it may walk: the edge it stands on, or the whole width. */
  const walkRange = useCallback((): [number, number] => {
    const perch = perchRef.current
    const ledge = perch && ledgesRef.current.find((l) => l.id === perch.id)
    return ledge ? [ledge.x, ledge.x + ledge.width] : [0, window.innerWidth]
  }, [])

  // ── The pointer ─────────────────────────────────────────────────────────
  // Standing about, it turns to look at the pointer nearby; when the pointer
  // rests close beside it, it pounces (not when told to stay put).
  useEffect(() => {
    if (!pointer || walking || dragging) return
    setFacingLeft(pointer.x < xRef.current + petWidth / 2)
    if (movement === 'still' || reducedMotion) return
    if (!withinPounce({ x: xRef.current, y: yRef.current, width: petWidth, height: petHeight }, pointer)) return
    const timer = window.setTimeout(() => setReaction('hop'), POUNCE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [pointer, walking, dragging, movement, reducedMotion, petWidth, petHeight])

  // ── Hit areas ───────────────────────────────────────────────────────────
  const reportFit = useCallback((capture: boolean) => {
    const rects = [petRef.current, bubbleRef.current, badgeRef.current]
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

  // Sit a while between walks.
  useEffect(() => {
    if (!sitting || !settings) return
    const [min, max] = SIT_PAUSE[settings.movement]
    if (!Number.isFinite(min)) return
    const timer = window.setTimeout(afterSit, min + Math.random() * (max - min))
    return () => window.clearTimeout(timer)
  }, [sitting, settings, afterSit])

  // ── Drag and click ──────────────────────────────────────────────────────
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, startY: event.clientY, petX: xRef.current, petY: yRef.current, moved: false }
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
      setSitting(true)
      // Dropped: the height it stands at from now on.
      groundRef.current = yRef.current
      // Where its feet are: the height it stands at from now on.
      void invoke(DRAG_END_COMMAND, { x: xRef.current, y: yRef.current + petHeight }).catch(() => {})
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
    // It stands where it was clicked until the menu closes (the command
    // returns then), and sits a while after.
    setMenuOpen(true)
    void invoke(MENU_COMMAND, { x: event.clientX, y: event.clientY, unread })
      .catch(() => {})
      .finally(() => {
        setMenuOpen(false)
        setSitting(true)
      })
  }

  const open = (bubble: PetBubble) => {
    if (bubble.sessionId) void invoke(OPEN_COMMAND, { notificationId: bubble.id }).catch(() => {})
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

  return (
    // The browser's own menu (Reload, Inspect) never shows over the pet.
    <div className="pet-strip" onContextMenu={(event) => event.preventDefault()}>
      {visible?.type === 'bubble' && (
        <div
          ref={bubbleRef}
          key={visible.bubble.id}
          className={`pet-bubble pet-bubble--${visible.bubble.tone}${bubbleSide}`}
          style={bubbleStyle}
          role="status"
        >
          <button type="button" className="pet-bubble-close" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismiss', id: visible.bubble.id })}>
            <X size={13} aria-hidden="true" />
          </button>
          <span className="pet-chip">
            <ToneMark tone={visible.bubble.tone} />
            {TONE_LABEL[visible.bubble.tone]}
          </span>
          <div className="pet-bubble-title">{visible.bubble.title}</div>
          {visible.bubble.body && <div className="pet-bubble-body">{visible.bubble.body}</div>}
          {visible.bubble.sessionId && (
            <div className="pet-bubble-actions">
              <button type="button" className="pet-button" onClick={() => open(visible.bubble)}>
                {visible.bubble.tone === 'input' ? 'Answer' : 'Open'}
              </button>
            </div>
          )}
        </div>
      )}
      {visible?.type === 'list' && (
        <div
          ref={bubbleRef}
          className={`pet-bubble pet-bubble--list${bubbleSide}`}
          style={bubbleStyle}
        >
          <button type="button" className="pet-bubble-close" aria-label="Close" onClick={() => dispatch({ type: 'toggleList' })}>
            <X size={13} aria-hidden="true" />
          </button>
          <div className="pet-bubble-title pet-bubble-title--list">{visible.items.length} unread</div>
          {visible.items.map((item) => (
            <div key={item.id} className="pet-list-row">
              <span className={`pet-chip pet-chip--icon pet-bubble--${item.tone}`}>
                <ToneMark tone={item.tone} />
              </span>
              <button type="button" className="pet-list-open" onClick={() => open(item)} title={item.body}>
                {item.title}
              </button>
              <button type="button" className="pet-list-dismiss" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismiss', id: item.id })}>
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        ref={petRef}
        className={`pet pet--${pose} pet--${character}${facingLeft && !traits.sideways ? ' pet--left' : ''}${dragging ? ' pet--dragging' : ''}${jumping ? ' pet--jump' : ''}`}
        style={{ width: petWidth, height: petHeight, transform: `translate(${left}px, ${top}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        role="img"
        aria-label={status.needsInput > 0 ? 'Desktop pet: an agent needs your answer' : 'Desktop pet'}
      >
        {badge > 0 && (
          <button
            ref={badgeRef}
            type="button"
            className="pet-badge"
            aria-label={`${badge} unread`}
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
        <div className="pet-body">
          <Sprite character={character} pose={pose} colour={settings.colour} />
        </div>
        {(pose === 'work' || pose === 'alert') && (
          <span className="pet-laptop" aria-hidden="true">
            <i />
            <b />
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * TerminalKeyBar — touch accessory row for keys soft keyboards lack.
 *
 * xterm.js's touch support is a long-standing upstream gap
 * (xtermjs/xterm.js#1101, #3727, #5377): no Esc/Tab/Ctrl/arrows on the soft
 * keyboard. This bar supplies them, following the accessory row of Termius.
 * It never scrolls: every key fits a 390pt phone, and the rest are one tap
 * away in More (``TerminalMoreSheet``).
 *
 * Two layouts, by whether the soft keyboard is up:
 *
 * - typing: Line, Esc, Tab, Ctrl, ^C, the four arrows, More. Line turns the
 *   command line field (``TerminalCommandField``) on or off.
 * - reading (keyboard down): Show keyboard, Esc, Tab, ^C, up, down, Enter,
 *   More, at the phone's full key width: enough to answer a program's prompt
 *   (an agent's "1. Yes / 2. No") without bringing the keyboard up.
 *
 * A swipe down on the bar puts the keyboard away. ``Ctrl`` is a sticky
 * modifier owned by the parent (``TerminalView``): soft-keyboard letters flow
 * through xterm's ``onData``, so the modifier is applied where every input
 * stream is forwarded (``terminal-modifiers.ts``), keys from this bar
 * included (Ctrl+← jumps a word). This bar only renders its state.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Ellipsis,
  Keyboard,
  TextCursorInput,
} from 'lucide-react'

import { swallowReleaseClick } from '@/hooks/use-long-press'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

interface TerminalKeyBarProps {
  /** Send one key's bytes as terminal input (the parent applies modifiers). */
  onKey: (data: string) => void
  /** Sticky-Ctrl state (armed = the next key is sent with Ctrl). */
  ctrlArmed: boolean
  onCtrlToggle: () => void
  /** The soft keyboard is up: the typing layout. */
  typing: boolean
  /** The command line field is on. */
  lineOn: boolean
  onLineToggle: () => void
  onShowKeyboard: () => void
  onHideKeyboard: () => void
  onMore: () => void
}

const ARROWS = {
  left: { label: 'Arrow left', seq: '\x1b[D', Icon: ArrowLeft },
  up: { label: 'Arrow up', seq: '\x1b[A', Icon: ArrowUp },
  down: { label: 'Arrow down', seq: '\x1b[B', Icon: ArrowDown },
  right: { label: 'Arrow right', seq: '\x1b[C', Icon: ArrowRight },
} as const

/** A drag down the bar this far (px) puts the keyboard away. */
const SWIPE_DOWN_PX = 24

/**
 * A key's shape and fill: armed (Ctrl, the field's switch) or plain. One fill
 * or the other, never both: ``cn`` does not merge, so two fills would leave
 * the winner to stylesheet order (an armed Ctrl used to look unarmed).
 */
function keyClass(armed = false): string {
  return cn(
    'flex h-10 min-w-0 flex-1 basis-0 items-center justify-center rounded-md',
    'text-xs font-medium active:bg-(--bg-key) select-none',
    armed ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)' : 'bg-(--color-surface-2) text-(--color-text)',
  )
}

const KEY_CLASS = keyClass()

/** Keep xterm's hidden input (or the command field) focused, so the soft keyboard stays up. */
const preventFocusLoss = (e: React.PointerEvent) => e.preventDefault()

interface KeyProps {
  label?: string
  pressed?: boolean
  className?: string
  onPress: () => void
  children: ReactNode
}

function Key({ label, pressed, className, onPress, children }: KeyProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={cn(keyClass(pressed), className)}
      onPointerDown={preventFocusLoss}
      onClick={() => {
        haptic('tick')
        onPress()
      }}
    >
      {children}
    </button>
  )
}

/** A key that repeats while held, like a hardware arrow key; one haptic per press. */
function RepeatableKey({ label, seq, onSend, children }: { label: string; seq: string; onSend: (seq: string) => void; children: ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pointerFiredRef = useRef(false)

  const stopRepeat = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    timerRef.current = null
    intervalRef.current = null
  }, [])

  const startRepeat = useCallback(() => {
    stopRepeat()
    pointerFiredRef.current = true
    haptic('tick')
    onSend(seq)
    timerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => onSend(seq), 70)
    }, 300)
  }, [seq, onSend, stopRepeat])

  useEffect(() => stopRepeat, [stopRepeat])

  return (
    <button
      type="button"
      aria-label={label}
      className={KEY_CLASS}
      onPointerDown={(e) => {
        e.preventDefault()
        startRepeat()
      }}
      onPointerUp={() => {
        stopRepeat()
        setTimeout(() => { pointerFiredRef.current = false }, 50)
      }}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onClick={() => {
        // A keyboard or assistive activation: no pointer press came first.
        if (!pointerFiredRef.current) {
          haptic('tick')
          onSend(seq)
        }
      }}
    >
      {children}
    </button>
  )
}

export function TerminalKeyBar({
  onKey,
  ctrlArmed,
  onCtrlToggle,
  typing,
  lineOn,
  onLineToggle,
  onShowKeyboard,
  onHideKeyboard,
  onMore,
}: TerminalKeyBarProps) {
  const swipeRef = useRef<{ x: number; y: number; done: boolean } | null>(null)

  const arrow = (key: keyof typeof ARROWS) => {
    const { label, seq, Icon } = ARROWS[key]
    return (
      <RepeatableKey key={key} label={label} seq={seq} onSend={onKey}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </RepeatableKey>
    )
  }
  const esc = <Key key="esc" onPress={() => onKey('\x1b')}>Esc</Key>
  const tab = <Key key="tab" onPress={() => onKey('\t')}>Tab</Key>
  const interrupt = (
    <Key key="interrupt" label="Send Ctrl+C (interrupt)" className="font-mono" onPress={() => onKey('\x03')}>^C</Key>
  )
  const more = (
    <Key key="more" label="More keys" onPress={onMore}>
      <Ellipsis className="h-4 w-4" aria-hidden="true" />
    </Key>
  )

  return (
    <div
      className="flex touch-none items-center gap-0.5 px-1 py-1"
      data-swipe-ignore
      role="toolbar"
      aria-label="Terminal keys"
      onPointerDown={(e) => {
        swipeRef.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, done: false }
      }}
      onPointerMove={(e) => {
        const swipe = swipeRef.current
        if (!swipe || swipe.done || !typing) return
        const dy = e.clientY - swipe.y
        if (dy > SWIPE_DOWN_PX && dy > Math.abs(e.clientX - swipe.x)) {
          swipe.done = true
          // The key under the finger must not also fire on release.
          swallowReleaseClick()
          onHideKeyboard()
        }
      }}
      onPointerUp={() => { swipeRef.current = null }}
      onPointerCancel={() => { swipeRef.current = null }}
    >
      {typing ? (
        <>
          <Key label="Command line field" pressed={lineOn} onPress={onLineToggle}>
            <TextCursorInput className="h-4 w-4" aria-hidden="true" />
          </Key>
          {esc}
          {tab}
          <Key pressed={ctrlArmed} onPress={onCtrlToggle}>Ctrl</Key>
          {interrupt}
          {arrow('left')}
          {arrow('up')}
          {arrow('down')}
          {arrow('right')}
          {more}
        </>
      ) : (
        <>
          <Key label="Show keyboard" onPress={onShowKeyboard}>
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </Key>
          {esc}
          {tab}
          {interrupt}
          {arrow('up')}
          {arrow('down')}
          <Key label="Enter" onPress={() => onKey('\r')}>
            <CornerDownLeft className="h-4 w-4" aria-hidden="true" />
          </Key>
          {more}
        </>
      )}
    </div>
  )
}

/**
 * TerminalKeyBar — mobile accessory row for keys soft keyboards lack.
 *
 * xterm.js's touch support is a long-standing upstream gap
 * (xtermjs/xterm.js#1101, #3727, #5377): no Esc/Tab/Ctrl/arrows on the
 * soft keyboard and unreliable touch paste. This bar supplies them,
 * following the accessory-row pattern of iSH / Termius.
 *
 * `Ctrl` is a sticky modifier owned by the parent (`TerminalView`):
 * soft-keyboard letters flow through xterm's `onData`, not this bar, so
 * the transform (letter → control code) must happen where that stream
 * is forwarded. This bar only renders the toggle state.
 * `Paste` reads the clipboard and forwards it as input.
 */

import { useCallback, useEffect, useRef } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
} from 'lucide-react'

import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

interface TerminalKeyBarProps {
  /** Send raw bytes/escape sequences as terminal input. */
  onKey: (data: string) => void
  /** Sticky-Ctrl state (armed = next letter becomes a control code). */
  ctrlArmed: boolean
  onCtrlToggle: () => void
}

const ARROW_KEYS = [
  { label: 'up', seq: '\x1b[A', Icon: ArrowUp },
  { label: 'down', seq: '\x1b[B', Icon: ArrowDown },
  { label: 'left', seq: '\x1b[D', Icon: ArrowLeft },
  { label: 'right', seq: '\x1b[C', Icon: ArrowRight },
] as const

const QUICK_SYMBOLS = [
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '~', seq: '~' },
  { label: '|', seq: '|' },
] as const

// Signals with no soft-keyboard equivalent — the three a mobile shell user
// reaches for constantly (kill a hung foreground process, close a REPL/
// send EOF, clear a scrolled-up screen).
const SIGNAL_KEYS = [
  { label: '^C', seq: '\x03', title: 'Send Ctrl+C (interrupt)' },
  { label: '^D', seq: '\x04', title: 'Send Ctrl+D (EOF)' },
  { label: '^L', seq: '\x0c', title: 'Send Ctrl+L (clear screen)' },
] as const

interface RepeatableKeyButtonProps {
  label: string
  seq: string
  Icon: React.ComponentType<{ className?: string }>
  onSend: (seq: string) => void
  keyClass: string
}

function RepeatableKeyButton({ label, seq, Icon, onSend, keyClass }: RepeatableKeyButtonProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pointerFiredRef = useRef(false)

  const stopRepeat = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const startRepeat = useCallback(() => {
    stopRepeat()
    pointerFiredRef.current = true
    onSend(seq)
    timerRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        onSend(seq)
      }, 70)
    }, 300)
  }, [seq, onSend, stopRepeat])

  useEffect(() => {
    return () => stopRepeat()
  }, [stopRepeat])

  return (
    <button
      type="button"
      aria-label={`Arrow ${label}`}
      className={keyClass}
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
        if (!pointerFiredRef.current) {
          onSend(seq)
        }
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

export function TerminalKeyBar({ onKey, ctrlArmed, onCtrlToggle }: TerminalKeyBarProps) {
  const send = useCallback(
    (seq: string) => {
      haptic('tick')
      onKey(seq)
    },
    [onKey],
  )

  const paste = useCallback(async () => {
    haptic('select')
    try {
      const text = await navigator.clipboard.readText()
      if (text) onKey(text)
    } catch {
      // Clipboard permission denied — nothing to do.
    }
  }, [onKey])

  const keyClass = cn(
    'flex h-9 min-w-9 items-center justify-center rounded-md px-2',
    'bg-(--color-surface-2) text-xs font-medium text-(--color-text)',
    'active:bg-(--bg-key) select-none',
  )

  const preventFocusLoss = (e: React.PointerEvent) => {
    // Prevent default pointerdown behavior so xterm's hidden textarea retains input focus
    // and the soft keyboard stays open smoothly without flashing.
    e.preventDefault()
  }

  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto px-1 py-1.5"
      data-swipe-ignore
      role="toolbar"
      aria-label="Terminal keys"
    >
      <button
        type="button"
        className={keyClass}
        onPointerDown={preventFocusLoss}
        onClick={() => send('\x1b')}
      >
        Esc
      </button>
      <button
        type="button"
        className={keyClass}
        onPointerDown={preventFocusLoss}
        onClick={() => send('\t')}
      >
        Tab
      </button>
      <button
        type="button"
        aria-pressed={ctrlArmed}
        className={cn(
          keyClass,
          ctrlArmed && 'bg-(--color-accent) text-(--color-accent-foreground)',
        )}
        onPointerDown={preventFocusLoss}
        onClick={() => {
          haptic('tick')
          onCtrlToggle()
        }}
      >
        Ctrl
      </button>

      {ARROW_KEYS.map(({ label, seq, Icon }) => (
        <RepeatableKeyButton
          key={label}
          label={label}
          seq={seq}
          Icon={Icon}
          onSend={send}
          keyClass={keyClass}
        />
      ))}

      <div className="mx-0.5 h-5 w-px shrink-0 bg-(--color-border)" aria-hidden="true" />

      {QUICK_SYMBOLS.map(({ label, seq }) => (
        <button
          key={label}
          type="button"
          aria-label={`Symbol ${label}`}
          className={cn(keyClass, 'font-mono')}
          onPointerDown={preventFocusLoss}
          onClick={() => send(seq)}
        >
          {label}
        </button>
      ))}

      <div className="mx-0.5 h-5 w-px shrink-0 bg-(--color-border)" aria-hidden="true" />

      {SIGNAL_KEYS.map(({ label, seq, title }) => (
        <button
          key={label}
          type="button"
          aria-label={title}
          title={title}
          className={cn(keyClass, 'font-mono')}
          onPointerDown={preventFocusLoss}
          onClick={() => send(seq)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Paste"
        className={keyClass}
        onPointerDown={preventFocusLoss}
        onClick={paste}
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

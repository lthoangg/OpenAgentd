/**
 * TerminalKeyBar — touch accessory row for keys soft keyboards lack.
 *
 * xterm.js's touch support is a long-standing upstream gap
 * (xtermjs/xterm.js#1101, #3727, #5377): no Esc/Tab/Ctrl/Alt/arrows on the
 * soft keyboard and unreliable touch paste. This bar supplies them,
 * following the accessory-row pattern of iSH / Termius.
 *
 * Order is by use, so the first screen of a 390pt phone holds what a shell
 * needs most: Esc, Ctrl, Alt, Tab, ^C and the arrows. The bar scrolls for
 * symbols, Home/End/PgUp/PgDn, ^D ^L ^R and Paste.
 *
 * `Ctrl` and `Alt` are sticky modifiers owned by the parent (`TerminalView`):
 * soft-keyboard letters flow through xterm's `onData`, not this bar, so the
 * modifier is applied where every input stream is forwarded
 * (`terminal-modifiers.ts`), keys from this bar included (Ctrl+← jumps a
 * word). This bar only renders their state.
 * `Paste` asks the parent, which pastes through xterm (bracketed paste, so
 * several lines go in as one paste instead of running one by one).
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface TerminalKeyBarProps {
  /** Send one key's bytes as terminal input (the parent applies modifiers). */
  onKey: (data: string) => void
  /** Paste the clipboard into the terminal. */
  onPaste: () => void
  /** Sticky-Ctrl state (armed = the next key is sent with Ctrl). */
  ctrlArmed: boolean
  onCtrlToggle: () => void
  /** Sticky-Alt state (armed = the next key is sent with Alt). */
  altArmed: boolean
  onAltToggle: () => void
}

const ARROW_KEYS = [
  { label: 'left', seq: '\x1b[D', Icon: ArrowLeft },
  { label: 'up', seq: '\x1b[A', Icon: ArrowUp },
  { label: 'down', seq: '\x1b[B', Icon: ArrowDown },
  { label: 'right', seq: '\x1b[C', Icon: ArrowRight },
] as const

const QUICK_SYMBOLS = [
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '~', seq: '~' },
  { label: '-', seq: '-' },
] as const

const NAV_KEYS = [
  { label: 'Home', seq: '\x1b[H', repeat: false },
  { label: 'End', seq: '\x1b[F', repeat: false },
  { label: 'PgUp', seq: '\x1b[5~', repeat: true },
  { label: 'PgDn', seq: '\x1b[6~', repeat: true },
] as const

// Signals and line keys with no soft-keyboard equivalent: close a REPL /
// send EOF, clear a scrolled-up screen, search the shell's history.
const SIGNAL_KEYS = [
  { label: '^D', seq: '\x04', title: 'Send Ctrl+D (EOF)' },
  { label: '^L', seq: '\x0c', title: 'Send Ctrl+L (clear screen)' },
  { label: '^R', seq: '\x12', title: 'Send Ctrl+R (search history)' },
] as const

const INTERRUPT = { label: '^C', seq: '\x03', title: 'Send Ctrl+C (interrupt)' } as const

const KEY_CLASS = cn(
  'flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md px-2',
  'bg-(--color-surface-2) text-xs font-medium text-(--color-text)',
  'active:bg-(--bg-key) select-none',
)

const ARMED_CLASS = 'bg-(--color-fill-selected) text-(--color-text-on-selected)'

/** Keep xterm's hidden input (or the command field) focused, so the soft keyboard stays up. */
const preventFocusLoss = (e: React.PointerEvent) => e.preventDefault()

interface RepeatableKeyButtonProps {
  label: string
  seq: string
  onSend: (seq: string) => void
  children: React.ReactNode
  className?: string
}

/** A key that repeats while held, like a hardware arrow key. */
function RepeatableKeyButton({ label, seq, onSend, children, className }: RepeatableKeyButtonProps) {
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
      aria-label={label}
      className={cn(KEY_CLASS, className)}
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
      {children}
    </button>
  )
}

function SignalKey({ label, seq, title, onSend }: { label: string; seq: string; title: string; onSend: (seq: string) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={title}
            className={cn(KEY_CLASS, 'font-mono')}
            onPointerDown={preventFocusLoss}
            onClick={() => onSend(seq)}
          >
            {label}
          </button>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

function Separator() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-(--color-border)" aria-hidden="true" />
}

export function TerminalKeyBar({ onKey, onPaste, ctrlArmed, onCtrlToggle, altArmed, onAltToggle }: TerminalKeyBarProps) {
  const send = useCallback(
    (seq: string) => {
      haptic('tick')
      onKey(seq)
    },
    [onKey],
  )

  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto px-1 py-1.5"
      data-swipe-ignore
      role="toolbar"
      aria-label="Terminal keys"
    >
      <button type="button" className={KEY_CLASS} onPointerDown={preventFocusLoss} onClick={() => send('\x1b')}>
        Esc
      </button>
      <button
        type="button"
        aria-pressed={ctrlArmed}
        className={cn(KEY_CLASS, ctrlArmed && ARMED_CLASS)}
        onPointerDown={preventFocusLoss}
        onClick={() => {
          haptic('tick')
          onCtrlToggle()
        }}
      >
        Ctrl
      </button>
      <button
        type="button"
        aria-pressed={altArmed}
        className={cn(KEY_CLASS, altArmed && ARMED_CLASS)}
        onPointerDown={preventFocusLoss}
        onClick={() => {
          haptic('tick')
          onAltToggle()
        }}
      >
        Alt
      </button>
      <button type="button" className={KEY_CLASS} onPointerDown={preventFocusLoss} onClick={() => send('\t')}>
        Tab
      </button>
      <SignalKey {...INTERRUPT} onSend={send} />

      {ARROW_KEYS.map(({ label, seq, Icon }) => (
        <RepeatableKeyButton key={label} label={`Arrow ${label}`} seq={seq} onSend={send}>
          <Icon className="h-3.5 w-3.5" />
        </RepeatableKeyButton>
      ))}

      <Separator />

      {QUICK_SYMBOLS.map(({ label, seq }) => (
        <button
          key={label}
          type="button"
          aria-label={`Symbol ${label}`}
          className={cn(KEY_CLASS, 'font-mono')}
          onPointerDown={preventFocusLoss}
          onClick={() => send(seq)}
        >
          {label}
        </button>
      ))}

      <Separator />

      {NAV_KEYS.map(({ label, seq, repeat }) =>
        repeat ? (
          <RepeatableKeyButton key={label} label={label} seq={seq} onSend={send}>
            {label}
          </RepeatableKeyButton>
        ) : (
          <button key={label} type="button" className={KEY_CLASS} onPointerDown={preventFocusLoss} onClick={() => send(seq)}>
            {label}
          </button>
        ),
      )}

      <Separator />

      {SIGNAL_KEYS.map((key) => (
        <SignalKey key={key.label} {...key} onSend={send} />
      ))}
      <button
        type="button"
        aria-label="Paste"
        className={KEY_CLASS}
        onPointerDown={preventFocusLoss}
        onClick={() => {
          haptic('select')
          onPaste()
        }}
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

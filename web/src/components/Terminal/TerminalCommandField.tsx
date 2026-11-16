/**
 * TerminalCommandField — an optional line field above the touch key bar.
 *
 * Typing straight into xterm goes through its hidden input, where iOS
 * composition (Vietnamese Telex, Chinese, Japanese), dictation and cursor
 * moves misbehave. This is an ordinary text field instead: the keyboard
 * works as in any app, and Return sends the line with Enter (an empty
 * Return sends Enter alone). It types into whatever runs in the shell, a
 * prompt or a program asking for input, as the keyboard would.
 *
 * The key bar's first key turns it on or off; the choice is kept on this
 * device.
 */
import { useState, type Ref } from 'react'
import { CornerDownLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export const TERMINAL_COMMAND_FIELD_KEY = 'oad:terminal-command-field'

/** Whether the field was left on, on this device. */
export function readCommandFieldOn(): boolean {
  try {
    return localStorage.getItem(TERMINAL_COMMAND_FIELD_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeCommandFieldOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(TERMINAL_COMMAND_FIELD_KEY, 'on')
    else localStorage.removeItem(TERMINAL_COMMAND_FIELD_KEY)
  } catch {
    // Storage unavailable (private mode): the field just isn't remembered.
  }
}

interface TerminalCommandFieldProps {
  /** Send ``line`` (possibly empty) followed by Enter. */
  onSubmit: (line: string) => void
  inputRef?: Ref<HTMLInputElement>
}

export function TerminalCommandField({ onSubmit, inputRef }: TerminalCommandFieldProps) {
  const [line, setLine] = useState('')
  return (
    <form
      className="flex items-center gap-1.5 px-1 pt-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(line)
        setLine('')
      }}
    >
      <Input
        ref={inputRef}
        value={line}
        onChange={(event) => setLine(event.target.value)}
        aria-label="Command"
        placeholder="Type a command"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        // 16px on touch, or iOS zooms the page when the field takes focus.
        className="h-9 flex-1 font-mono pointer-coarse:text-base"
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Send to terminal"
        // Keep the field focused, so the keyboard stays up for the next line.
        onPointerDown={(event) => event.preventDefault()}
      >
        <CornerDownLeft aria-hidden="true" />
      </Button>
    </form>
  )
}

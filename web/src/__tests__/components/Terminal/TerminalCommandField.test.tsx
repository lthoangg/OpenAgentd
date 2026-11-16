import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  readCommandFieldOn,
  TERMINAL_COMMAND_FIELD_KEY,
  TerminalCommandField,
  writeCommandFieldOn,
} from '@/components/Terminal/TerminalCommandField'

beforeEach(() => localStorage.removeItem(TERMINAL_COMMAND_FIELD_KEY))
afterEach(cleanup)

describe('TerminalCommandField', () => {
  it('is a plain text field the keyboard does not correct or capitalize', () => {
    render(<TerminalCommandField onSubmit={() => {}} />)
    const field = screen.getByRole('textbox', { name: 'Command' })
    expect(field.getAttribute('autocorrect')).toBe('off')
    expect(field.getAttribute('autocapitalize')).toBe('off')
    expect(field.getAttribute('spellcheck')).toBe('false')
    expect(field.getAttribute('enterkeyhint')).toBe('send')
  })

  it('sends the line on Return, as typed (Telex/IME text included), and empties the field', () => {
    const onSubmit = mock(() => {})
    render(<TerminalCommandField onSubmit={onSubmit} />)
    const field = screen.getByRole('textbox', { name: 'Command' })
    fireEvent.change(field, { target: { value: 'echo "xin chào"' } })
    fireEvent.submit(field.closest('form')!)
    expect(onSubmit).toHaveBeenCalledWith('echo "xin chào"')
    expect(field).toHaveValue('')
  })

  it('sends an empty line (Enter alone) from an empty field', () => {
    const onSubmit = mock(() => {})
    render(<TerminalCommandField onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }))
    expect(onSubmit).toHaveBeenCalledWith('')
  })

  it('remembers on this device whether it is on', () => {
    expect(readCommandFieldOn()).toBe(false)
    writeCommandFieldOn(true)
    expect(readCommandFieldOn()).toBe(true)
    writeCommandFieldOn(false)
    expect(readCommandFieldOn()).toBe(false)
  })
})

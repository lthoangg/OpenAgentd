import React, { useState } from 'react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))

import { InputComposer } from '@/components/InputComposer'
import { useStrandedFocusGuard } from '@/hooks/use-dock-focus'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useKeyLayer } from '@/lib/keyboard/hooks'

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
})

const tab = () => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

function Guarded({ dialog = false }: { dialog?: boolean }) {
  const [shown, setShown] = useState(true)
  useStrandedFocusGuard(true, () => document.getElementById('home')?.focus())
  useKeyLayer(dialog, { kind: 'dialog' })
  return (
    <>
      <button type="button" id="home">composer</button>
      {shown && <button type="button" onClick={() => setShown(false)}>doomed</button>}
    </>
  )
}

describe('stranded focus guard', () => {
  it('sends a Tab that starts from <body> to the composer instead of the top of the page', () => {
    render(<Guarded />)
    const doomed = screen.getByRole('button', { name: 'doomed' })
    doomed.focus()
    act(() => doomed.click())
    expect(document.activeElement).toBe(document.body)
    const event = tab()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'composer' }))
  })

  it('leaves focus alone when it is on a control, or a dialog owns it', () => {
    const { unmount } = render(<Guarded />)
    screen.getByRole('button', { name: 'doomed' }).focus()
    expect(tab().defaultPrevented).toBe(false)
    unmount()
    render(<Guarded dialog />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(tab().defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('composer keeps focus', () => {
  it('keeps every composer action in Tab order', () => {
    render(<InputComposer onSubmit={() => {}} onInteractionModeChange={() => {}} interactionMode="code" />)
    expect(screen.queryByRole('toolbar')).toBeNull()
    const enabled = screen.getAllByRole('button').filter((el) => !(el as HTMLButtonElement).disabled)
    expect(enabled.length).toBeGreaterThan(1)
    expect(enabled.every((el) => el.tabIndex === 0)).toBe(true)
  })

  it('keeps focus in the message after a send', () => {
    render(<InputComposer onSubmit={() => {}} />)
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    textbox.focus()
    fireEvent.change(textbox, { target: { value: 'hello' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(textbox.value).toBe('')
    expect(document.activeElement).toBe(textbox)
  })

  it('takes focus back quietly when handed it (no focus ring for a script focus)', () => {
    const ref = { current: null as import('@/components/InputComposer').InputComposerHandle | null }
    render(<InputComposer ref={(h) => { ref.current = h }} onSubmit={() => {}} />)
    ref.current?.focus({ expand: false })
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })
})

/**
 * Dragging or tapping the transcript while the soft keyboard is up puts it
 * away; touches on text fields and controls are left alone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { useDismissKeyboardOnTouch } from '@/hooks/use-mobile-viewport'

function Transcript() {
  const ref = useRef<HTMLDivElement>(null)
  useDismissKeyboardOnTouch(ref)
  return (
    <div ref={ref} data-testid="transcript">
      <p data-testid="text">Some reply</p>
      <button type="button">Copy</button>
      <textarea aria-label="Your answer" />
    </div>
  )
}

function touch(target: Element, type: string, clientY?: number) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'touches', { value: clientY === undefined ? [] : [{ clientY }] })
  target.dispatchEvent(event)
}

function openKeyboardWithFocus(): HTMLTextAreaElement {
  document.documentElement.setAttribute('data-keyboard-open', '')
  const composer = document.createElement('textarea')
  document.body.appendChild(composer)
  composer.focus()
  return composer
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-keyboard-open')
  document.querySelectorAll('body > textarea').forEach((el) => el.remove())
})

describe('useDismissKeyboardOnTouch', () => {
  it('dismisses the keyboard when the transcript is dragged', () => {
    render(<Transcript />)
    const composer = openKeyboardWithFocus()
    const text = screen.getByTestId('text')
    touch(text, 'touchstart', 300)
    touch(text, 'touchmove', 340)

    expect(document.activeElement).not.toBe(composer)
  })

  it('dismisses the keyboard on a tap on plain content', () => {
    render(<Transcript />)
    const composer = openKeyboardWithFocus()
    const text = screen.getByTestId('text')
    touch(text, 'touchstart', 300)
    touch(text, 'touchend')

    expect(document.activeElement).not.toBe(composer)
  })

  it('leaves taps on controls and touches in text fields alone', () => {
    render(<Transcript />)
    const composer = openKeyboardWithFocus()
    const copy = screen.getByRole('button', { name: 'Copy' })
    touch(copy, 'touchstart', 300)
    touch(copy, 'touchend')
    expect(document.activeElement).toBe(composer)

    const answer = screen.getByLabelText('Your answer')
    touch(answer, 'touchstart', 300)
    touch(answer, 'touchmove', 360)
    expect(document.activeElement).toBe(composer)
  })

  it('does nothing while the keyboard is down', () => {
    render(<Transcript />)
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    composer.focus()
    const text = screen.getByTestId('text')
    touch(text, 'touchstart', 300)
    touch(text, 'touchmove', 360)

    expect(document.activeElement).toBe(composer)
  })
})

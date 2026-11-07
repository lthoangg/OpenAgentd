/**
 * The phone composer's keyboard swipe: up on the box raises the keyboard
 * (focus on touchend, inside the gesture iOS needs), down puts it away.
 * Sideways drags, a message field that can still scroll, and the menus and
 * tray above the box are left alone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { useComposerKeyboardSwipe } from '@/hooks/use-composer-keyboard-swipe'

let focused = 0

function Composer({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  useComposerKeyboardSwipe(ref, {
    enabled,
    focus: () => {
      focused++
      fieldRef.current?.focus()
    },
  })
  return (
    <div ref={ref}>
      <div data-composer-tray="" className="contents">
        <p data-testid="tray">Side question</p>
      </div>
      <ul role="listbox" aria-label="Suggestions"><li role="option" aria-selected="false">@file</li></ul>
      <div data-testid="pill">
        <textarea ref={fieldRef} aria-label="Message input" />
        <button type="button">Send</button>
      </div>
    </div>
  )
}

type Point = { x?: number; y: number }

function touch(target: Element, type: string, point: Point | null) {
  const event = new Event(type, { bubbles: true })
  const list = point ? [{ clientX: point.x ?? 100, clientY: point.y }] : []
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list })
  Object.defineProperty(event, 'changedTouches', { value: list })
  target.dispatchEvent(event)
}

function swipe(target: Element, from: Point, to: Point) {
  touch(target, 'touchstart', from)
  touch(target, 'touchmove', { x: (from.x ?? 100) + ((to.x ?? 100) - (from.x ?? 100)) / 2, y: (from.y + to.y) / 2 })
  touch(target, 'touchmove', to)
  touch(target, 'touchend', to)
}

/** Give the field a scroll position and a content height (happy-dom lays nothing out). */
function scrollable(field: HTMLTextAreaElement, scrollTop: number) {
  Object.defineProperty(field, 'clientHeight', { configurable: true, value: 100 })
  Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 300 })
  field.scrollTop = scrollTop
}

afterEach(() => {
  cleanup()
  focused = 0
  document.documentElement.removeAttribute('data-keyboard-open')
})

describe('useComposerKeyboardSwipe', () => {
  it('raises the keyboard on a swipe up, focusing on touchend', () => {
    render(<Composer />)
    const pill = screen.getByTestId('pill')
    touch(pill, 'touchstart', { y: 500 })
    touch(pill, 'touchmove', { y: 460 })
    expect(focused).toBe(0)
    touch(pill, 'touchend', { y: 460 })
    expect(focused).toBe(1)
    expect(document.activeElement).toBe(screen.getByLabelText('Message input'))
  })

  it('needs a real swipe: a short one or a tap does nothing', () => {
    render(<Composer />)
    const pill = screen.getByTestId('pill')
    swipe(pill, { y: 500 }, { y: 485 })
    touch(pill, 'touchstart', { y: 500 })
    touch(pill, 'touchend', { y: 500 })
    expect(focused).toBe(0)
  })

  it('puts the keyboard away on a swipe down', () => {
    render(<Composer />)
    const field = screen.getByLabelText('Message input') as HTMLTextAreaElement
    field.focus()
    document.documentElement.setAttribute('data-keyboard-open', '')
    swipe(screen.getByTestId('pill'), { y: 400 }, { y: 460 })
    expect(document.activeElement).not.toBe(field)
  })

  it('does not raise the keyboard that is already up', () => {
    render(<Composer />)
    document.documentElement.setAttribute('data-keyboard-open', '')
    swipe(screen.getByTestId('pill'), { y: 500 }, { y: 440 })
    expect(focused).toBe(0)
  })

  it('leaves a sideways drag (an edge swipe) alone', () => {
    render(<Composer />)
    swipe(screen.getByTestId('pill'), { x: 10, y: 500 }, { x: 200, y: 460 })
    expect(focused).toBe(0)
  })

  it('lets a message that can still scroll take the swipe', () => {
    render(<Composer />)
    const field = screen.getByLabelText('Message input') as HTMLTextAreaElement
    // Not at the end: a swipe up scrolls the message on.
    scrollable(field, 50)
    swipe(field, { y: 500 }, { y: 440 })
    expect(focused).toBe(0)

    // Keyboard up and not at the top: a swipe down scrolls back first.
    field.focus()
    document.documentElement.setAttribute('data-keyboard-open', '')
    swipe(field, { y: 400 }, { y: 460 })
    expect(document.activeElement).toBe(field)

    // At the top, the next swipe down puts the keyboard away.
    field.scrollTop = 0
    swipe(field, { y: 400 }, { y: 460 })
    expect(document.activeElement).not.toBe(field)
  })

  it('ignores the suggestion menu and the tray above the box', () => {
    render(<Composer />)
    swipe(screen.getByRole('listbox'), { y: 500 }, { y: 440 })
    swipe(screen.getByTestId('tray'), { y: 500 }, { y: 440 })
    expect(focused).toBe(0)
  })

  it('does nothing when disabled', () => {
    render(<Composer enabled={false} />)
    swipe(screen.getByTestId('pill'), { y: 500 }, { y: 440 })
    expect(focused).toBe(0)
  })

  it('marks the box so the browser does not take a vertical swipe as a pan', () => {
    // A pan cancels the pointer, and focus without its user activation raises
    // no keyboard (Android Chrome); index.css keys touch-action off these marks.
    const view = render(<Composer />)
    const box = screen.getByTestId('pill').parentElement as HTMLElement
    const field = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(box.hasAttribute('data-keyboard-swipe')).toBe(true)
    expect(field.hasAttribute('data-swipe-scrolls')).toBe(false)

    // Lines to scroll: the field keeps its own vertical pan, as of the next touch.
    scrollable(field, 0)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    expect(field.hasAttribute('data-swipe-scrolls')).toBe(true)

    view.rerender(<Composer enabled={false} />)
    expect(box.hasAttribute('data-keyboard-swipe')).toBe(false)
    expect(field.hasAttribute('data-swipe-scrolls')).toBe(false)
  })

  it('lets the browser pan the box sideways only (index.css)', () => {
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
    expect(css).toMatch(/\[data-keyboard-swipe\],\s*\[data-keyboard-swipe\] textarea:not\(\[data-swipe-scrolls\]\)\s*\{\s*touch-action:\s*pan-x pinch-zoom;/)
  })
})

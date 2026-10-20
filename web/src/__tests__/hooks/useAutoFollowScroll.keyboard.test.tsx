/**
 * The soft keyboard shrinks the transcript's scrollport from the bottom while
 * scrollTop stays put. A reader following the conversation is re-pinned to
 * the newest message once the keyboard settles; a reader scrolled up is left
 * where they are.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { KEYBOARD_SETTLE_MS, _resetScrollMemoryForTests, useAutoFollowScroll } from '@/hooks/useAutoFollowScroll'

let hook: ReturnType<typeof useAutoFollowScroll> | null = null

function Harness() {
  hook = useAutoFollowScroll({ totalLen: 1, isEmpty: false })
  return (
    <div ref={hook.scrollRef}>
      <div ref={hook.contentRef}>content</div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  hook = null
  _resetScrollMemoryForTests()
  document.documentElement.removeAttribute('data-keyboard-open')
})

function layOut(el: HTMLDivElement, { scrollTop }: { scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true, writable: true })
  // The keyboard has shrunk the scrollport from 500 to 200 px.
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true, writable: true })
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true, writable: true })
}

async function openKeyboardAndSettle() {
  await act(async () => {
    document.documentElement.setAttribute('data-keyboard-open', '')
    await new Promise((resolve) => setTimeout(resolve, KEYBOARD_SETTLE_MS + 50))
  })
}

describe('useAutoFollowScroll and the soft keyboard', () => {
  it('re-pins a reader at the bottom once the keyboard settles', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    layOut(el, { scrollTop: 500 })

    await openKeyboardAndSettle()

    expect(el.scrollTop).toBe(800)
  })

  it('leaves a reader who scrolled up where they are', async () => {
    render(<Harness />)
    const el = hook!.scrollRef.current!
    layOut(el, { scrollTop: 120 })
    hook!.attachedRef.current = false

    await openKeyboardAndSettle()

    expect(el.scrollTop).toBe(120)
  })
})

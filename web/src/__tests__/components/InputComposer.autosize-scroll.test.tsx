/**
 * Autosize must not move the transcript. ``resize()`` collapses the textarea
 * to ``auto`` to measure it, which briefly grows the transcript scroller; the
 * browser clamps its scrollTop to the smaller max and the clamp sticks. The
 * layout is modelled here with instance getters (Happy DOM has no layout).
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { composerMaxHeight, useTextareaAutosize } from '@/components/InputComposer.autosize'

type Api = ReturnType<typeof useTextareaAutosize>
let api: Api

function Harness({ transcript = true }: { transcript?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  api = useTextareaAutosize(ref)
  return (
    <main>
      {transcript && <div className="oa-chat-scroll" />}
      <div>
        <textarea ref={ref} rows={1} />
      </div>
    </main>
  )
}

function setup(initialTextareaHeight: number, initialScrollTop: number) {
  const view = render(<Harness />)
  const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
  const scroller = view.container.querySelector('.oa-chat-scroll') as HTMLDivElement

  const composerHeight = () =>
    textarea.style.height === 'auto' ? 20 : parseFloat(textarea.style.height)
  const clientHeight = () => 500 - composerHeight()
  const maxTop = () => 1000 - clientHeight()
  let top = 0
  // A browser re-clamps scrollTop whenever layout changes, not only on access.
  const realStyle = textarea.style
  const style = new Proxy(realStyle, {
    get: (t, p) => Reflect.get(t, p, t),
    set: (t, p, v) => {
      Reflect.set(t, p, v, t)
      top = Math.min(Math.max(top, 0), maxTop())
      return true
    },
  })
  Object.defineProperty(textarea, 'style', { configurable: true, get: () => style })

  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 60 })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: clientHeight })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => (top = Math.min(Math.max(top, 0), maxTop())),
    set: (v: number) => {
      top = Math.min(Math.max(v, 0), maxTop())
    },
  })

  textarea.style.height = `${initialTextareaHeight}px`
  scroller.scrollTop = initialScrollTop
  return { textarea, scroller }
}

describe('useTextareaAutosize keeps the transcript scroll offset', () => {
  afterEach(cleanup)

  it('keeps a transcript at the bottom at the bottom', () => {
    const { textarea, scroller } = setup(60, 560)
    expect(scroller.scrollTop).toBe(560)
    api.resize()
    expect(textarea.style.height).toBe('60px')
    expect(scroller.scrollTop).toBe(560)
  })

  it('leaves a reader scrolled up where they were', () => {
    const { textarea, scroller } = setup(60, 300)
    api.resize()
    expect(textarea.style.height).toBe('60px')
    expect(scroller.scrollTop).toBe(300)
  })

  it('still resizes when there is no transcript (inline composer)', () => {
    const view = render(<Harness transcript={false} />)
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 60 })
    api.resize()
    expect(textarea.style.height).toBe('60px')
  })

  it('caps at the CSS max-height (six lines), else 120px', () => {
    const view = render(<Harness transcript={false} />)
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 400 })
    api.resize()
    expect(textarea.style.height).toBe('120px')
    textarea.style.maxHeight = '135px'
    api.resize()
    expect(textarea.style.height).toBe('135px')
  })
})

describe('composerMaxHeight', () => {
  it('is six line-heights', () => {
    expect(composerMaxHeight()).toBe('6lh')
  })
})

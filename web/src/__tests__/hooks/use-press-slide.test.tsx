/**
 * usePressSlide: a touch follows the finger across targets, the release
 * picks the one under it, a hold fires once, and the click that follows a
 * touch release is swallowed.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { usePressSlide, type PressSlideOptions } from '@/hooks/use-press-slide'
import { LONG_PRESS_MS } from '@/hooks/use-long-press'

afterEach(cleanup)

// Three 40px targets in a row: a 0–40, b 40–80, c 80–120 (y 0–40).
function place(element: HTMLElement, left: number) {
  element.getBoundingClientRect = () =>
    ({ left, right: left + 40, top: 0, bottom: 40, width: 40, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
}

function Harness(props: PressSlideOptions & { onClick?: (id: string) => void }) {
  const { active, handlers } = usePressSlide(props)
  return (
    <div data-testid="container" {...handlers}>
      {['a', 'b', 'c'].map((id, index) => (
        <button
          key={id}
          type="button"
          data-slide-id={id}
          data-active={active === id ? '' : undefined}
          ref={(element) => { if (element) place(element, index * 40) }}
          onClick={() => props.onClick?.(id)}
        >
          {id}
        </button>
      ))}
    </div>
  )
}

const touch = (x: number, extra: Record<string, unknown> = {}) => ({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: 20, ...extra })

describe('usePressSlide', () => {
  it('moves the highlight with the finger and releases on the target under it', () => {
    const onChange = mock(() => {})
    const onRelease = mock(() => {})
    render(<Harness onChange={onChange} onRelease={onRelease} />)
    const a = screen.getByText('a')

    fireEvent.pointerDown(a, touch(20))
    expect(a.hasAttribute('data-active')).toBe(true)
    fireEvent.pointerMove(a, touch(60))
    expect(screen.getByText('b').hasAttribute('data-active')).toBe(true)
    expect(a.hasAttribute('data-active')).toBe(false)
    fireEvent.pointerMove(a, touch(100))
    fireEvent.pointerUp(a, touch(100))

    expect(onChange.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(onRelease).toHaveBeenCalledWith('c', { moved: true, held: false })
    expect(screen.getByText('c').hasAttribute('data-active')).toBe(false)
  })

  it('releases on null off every target', () => {
    const onRelease = mock(() => {})
    render(<Harness onRelease={onRelease} />)

    fireEvent.pointerDown(screen.getByText('a'), touch(20))
    fireEvent.pointerUp(screen.getByText('a'), touch(300))

    expect(onRelease).toHaveBeenCalledWith(null, { moved: false, held: false })
  })

  it('swallows the click a touch release raises, but not a later keyboard or mouse click', () => {
    const onClick = mock(() => {})
    const onRelease = mock(() => {})
    render(<Harness onRelease={onRelease} onClick={onClick} />)
    const a = screen.getByText('a')

    fireEvent.pointerDown(a, touch(20))
    fireEvent.pointerUp(a, touch(20))
    fireEvent.click(a)
    expect(onRelease).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()

    fireEvent.click(a)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('leaves the mouse to the buttons', () => {
    const onRelease = mock(() => {})
    const onClick = mock(() => {})
    render(<Harness onRelease={onRelease} onClick={onClick} />)
    const a = screen.getByText('a')

    fireEvent.pointerDown(a, touch(20, { pointerType: 'mouse' }))
    fireEvent.pointerUp(a, touch(20, { pointerType: 'mouse' }))
    fireEvent.click(a)

    expect(onRelease).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('fires a hold once on a still press where canHold allows, and reports it on release', async () => {
    const onHold = mock(() => {})
    const onRelease = mock(() => {})
    render(<Harness onRelease={onRelease} onHold={onHold} canHold={(id) => id === 'c'} />)

    fireEvent.pointerDown(screen.getByText('c'), touch(100))
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 40)))
    expect(onHold).toHaveBeenCalledWith('c')
    fireEvent.pointerUp(screen.getByText('c'), touch(100))
    expect(onRelease).toHaveBeenCalledWith('c', { moved: false, held: true })

    fireEvent.pointerDown(screen.getByText('a'), touch(20))
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 40)))
    expect(onHold).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(screen.getByText('a'), touch(20))
  })

  it('drops the hold once the finger moves', async () => {
    const onHold = mock(() => {})
    render(<Harness onRelease={() => {}} onHold={onHold} />)

    fireEvent.pointerDown(screen.getByText('a'), touch(20))
    fireEvent.pointerMove(screen.getByText('a'), touch(60))
    await act(() => new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 40)))

    expect(onHold).not.toHaveBeenCalled()
    fireEvent.pointerUp(screen.getByText('a'), touch(60))
  })

  it('resets on pointercancel without a release', () => {
    const onRelease = mock(() => {})
    const onCancel = mock(() => {})
    render(<Harness onRelease={onRelease} onCancel={onCancel} />)
    const a = screen.getByText('a')

    fireEvent.pointerDown(a, touch(20))
    fireEvent.pointerCancel(a, touch(20))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onRelease).not.toHaveBeenCalled()
    expect(a.hasAttribute('data-active')).toBe(false)
  })
})

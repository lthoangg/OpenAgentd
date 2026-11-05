import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EyeOff, Pin } from 'lucide-react'

// Reduced motion makes a release snap, so most tests read the resting place
// at once; one test turns it off to watch the spring arrive.
let reduced = true
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => reduced }))

const tick = mock(() => undefined)
mock.module('@/lib/haptics', () => ({
  selectionHapticFeedback: tick,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: () => undefined,
  alignmentHapticFeedback: () => undefined,
  outcomeHapticFeedback: () => undefined,
  haptic: () => undefined,
}))

const { SwipeRow, _resetSwipeRowsForTests } = await import('@/components/phone/SwipeRow')
type SwipeAction = import('@/components/phone/SwipeRow').SwipeAction

/** Two actions: 144px of reveal, 72px to the half-way point. */
const WIDTH = 144

function actionsFor(onPin: () => void, onHide: () => void): SwipeAction[] {
  return [
    { id: 'pin', label: 'Pin', icon: Pin, tone: 'accent', onAction: onPin },
    { id: 'hide', label: 'Hide', icon: EyeOff, tone: 'destructive', onAction: onHide },
  ]
}

type PointerKind = 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel'

/**
 * A touch pointer event stamped ``t`` ms after the gesture began. Every event
 * is stamped so the release velocity is the test's choice, not the wall
 * clock's. The clock starts well above 0: a real ``timeStamp`` is never 0, and
 * the component treats a falsy one as missing.
 */
function pointer(type: PointerKind, el: Element, x: number, y: number, t: number, pointerType = 'touch') {
  const event = createEvent[type](el, { pointerType, pointerId: 1, clientX: x, clientY: y })
  Object.defineProperty(event, 'timeStamp', { value: 1000 + t })
  fireEvent(el, event)
}

/** A slow drag: one move, 100ms after the press, 100ms before the lift (no release speed). */
function slowDrag(el: Element, fromX: number, toX: number, dy = 2) {
  pointer('pointerDown', el, fromX, 20, 0)
  pointer('pointerMove', el, toX, 20 + dy, 100)
  pointer('pointerUp', el, toX, 20 + dy, 200)
}

interface RowOptions {
  disabled?: boolean
  onPin?: () => void
  onHide?: () => void
  onRowClick?: () => void
  name?: string
}

function row({ disabled, onPin = () => {}, onHide = () => {}, onRowClick = () => {}, name = 'Session' }: RowOptions = {}) {
  return (
    <SwipeRow actions={actionsFor(onPin, onHide)} disabled={disabled}>
      <button type="button" onClick={onRowClick}>{name}</button>
    </SwipeRow>
  )
}

const contentOf = (root: Element) => root.querySelector<HTMLElement>('[data-swipe-row-content]')!
const rowButton = (name = 'Session') => screen.getByRole('button', { name })
/**
 * A revealed action while the row is shut. testing-library gives a hidden
 * node an empty accessible name, so find it by its text instead.
 */
const hiddenAction = (label: string) =>
  screen.getAllByRole('button', { hidden: true }).find((button) => button.textContent === label)!
/** The row's root and its sliding content, found from the button inside it. */
function parts(name = 'Session') {
  const root = rowButton(name).closest<HTMLElement>('[data-swipe-row]')!
  return { root, content: contentOf(root) }
}

beforeEach(() => {
  reduced = true
  tick.mockClear()
})
afterEach(() => {
  cleanup()
  _resetSwipeRowsForTests()
})

describe('SwipeRow', () => {
  it('opens when dragged past half the actions and rests at minus their width', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 200, 22, 100)
    // The row follows the finger, less the 8px slop it waited out.
    expect(content.style.translate).toBe('-92px 0')
    pointer('pointerUp', rowButton(), 200, 22, 200)
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
  })

  it('snaps back when released under half', () => {
    render(row())
    const { content } = parts()
    slowDrag(rowButton(), 300, 250)
    expect(content.style.translate).toBe('')
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
  })

  it('opens on a leftward fling however short the drag', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 270, 21, 10)
    // 22px of travel is well under half, but 3px/ms (smoothed to 0.9) is a flick.
    expect(parseFloat(content.style.translate)).toBe(-22)
    pointer('pointerUp', rowButton(), 270, 21, 12)
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
  })

  it('does not fling open on a finger that rested before lifting', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 270, 21, 10)
    pointer('pointerUp', rowButton(), 270, 21, 400)
    expect(content.style.translate).toBe('')
  })

  it('does not open on a vertical drag, so the list can scroll', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 100, 0)
    pointer('pointerMove', rowButton(), 296, 140, 20)
    // The gesture was given up at the first move: a later sideways swing is not ours.
    pointer('pointerMove', rowButton(), 150, 150, 40)
    pointer('pointerUp', rowButton(), 150, 150, 60)
    expect(content.style.translate).toBe('')
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
  })

  it('does not open on a diagonal drag that is not clearly horizontal', () => {
    render(row())
    const { content } = parts()
    // 30 across, 25 down: horizontal, but not 1.5 times the vertical.
    pointer('pointerDown', rowButton(), 300, 100, 0)
    pointer('pointerMove', rowButton(), 270, 125, 20)
    pointer('pointerUp', rowButton(), 270, 125, 40)
    expect(content.style.translate).toBe('')
  })

  it('ignores a mouse drag', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0, 'mouse')
    pointer('pointerMove', rowButton(), 150, 22, 100, 'mouse')
    pointer('pointerUp', rowButton(), 150, 22, 200, 'mouse')
    expect(content.style.translate).toBe('')
  })

  it('does not move on a rightward drag of a shut row', () => {
    render(row())
    const { content } = parts()
    slowDrag(rowButton(), 100, 220)
    expect(content.style.translate).toBe('')
  })

  it('rubber-bands at 0.3× beyond the actions, then rests open', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 100, 22, 100)
    // Finger travel 192px, 48px past the 144px of actions: 144 + 48 * 0.3.
    expect(parseFloat(content.style.translate)).toBeCloseTo(-158.4, 1)
    pointer('pointerUp', rowButton(), 100, 22, 200)
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
  })

  it('shuts an open row dragged back under half', () => {
    render(row())
    const { content } = parts()
    slowDrag(rowButton(), 300, 200)
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
    slowDrag(rowButton(), 100, 220)
    expect(content.style.translate).toBe('')
  })

  it('ticks once as the drag crosses the open threshold, each way', () => {
    render(row())
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 280, 21, 100)
    expect(tick).toHaveBeenCalledTimes(0)
    pointer('pointerMove', rowButton(), 200, 22, 200)
    expect(tick).toHaveBeenCalledTimes(1)
    pointer('pointerMove', rowButton(), 190, 22, 300)
    expect(tick).toHaveBeenCalledTimes(1)
    pointer('pointerMove', rowButton(), 290, 22, 400)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('lets go when the browser takes the gesture over (a scroll began)', () => {
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 200, 22, 100)
    pointer('pointerCancel', rowButton(), 200, 22, 150)
    // Cancelled mid-drag: back to where it began, which was shut.
    expect(content.style.translate).toBe('')
  })

  describe('actions', () => {
    it('calls the action when tapped, then closes the row', () => {
      const onPin = mock(() => {})
      const onHide = mock(() => {})
      render(row({ onPin, onHide }))
      const { content } = parts()
      slowDrag(rowButton(), 300, 200)

      fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
      expect(onPin).toHaveBeenCalledTimes(1)
      expect(onHide).not.toHaveBeenCalled()
      expect(content.style.translate).toBe('')
      expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
    })

    it('hides them from assistive tech and the tab order while shut', () => {
      render(row())
      expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
      const pin = hiddenAction('Pin')
      expect(pin.getAttribute('aria-hidden')).toBe('true')
      expect(pin.getAttribute('tabindex')).toBe('-1')
      // The row itself stays reachable.
      expect(rowButton()).toBeTruthy()
    })

    it('exposes them once open', () => {
      render(row())
      slowDrag(rowButton(), 300, 200)
      const pin = screen.getByRole('button', { name: 'Pin' })
      expect(pin.getAttribute('aria-hidden')).toBeNull()
      expect(pin.getAttribute('tabindex')).toBeNull()
      expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy()
    })

    it('renders each action 72px wide behind the content, with its icon over its label', () => {
      render(row())
      const { root } = parts()
      const pin = hiddenAction('Pin')
      expect(pin.querySelector('svg')?.getAttribute('width')).toBe('16')
      expect(pin.querySelector('span')?.textContent).toBe('Pin')
      expect(pin.className).toContain('bg-(--color-accent)')
      expect(pin.className).toContain('text-(--color-text-on-accent)')
      const hide = hiddenAction('Hide')
      expect(hide.className).toContain('bg-(--color-error)')
      // Shut, the actions are fully clipped; their strip is the actions' total width.
      const strip = pin.parentElement as HTMLElement
      expect(strip.style.width).toBe(`${WIDTH}px`)
      expect(strip.style.clipPath).toBe('inset(0 0 0 100%)')
      expect(root.contains(strip)).toBe(true)
    })

    it('uses the keycap wash for a neutral action', () => {
      render(
        <SwipeRow actions={[{ id: 'mute', label: 'Mute', icon: EyeOff, tone: 'neutral', onAction: () => {} }]}>
          <button type="button">Session</button>
        </SwipeRow>,
      )
      expect(hiddenAction('Mute').className).toContain('bg-(--bg-key)')
    })
  })

  describe('tapping an open row', () => {
    it('closes it and does not click through to the row', () => {
      const onRowClick = mock(() => {})
      render(row({ onRowClick }))
      const { content } = parts()
      slowDrag(rowButton(), 300, 200)
      expect(content.style.translate).toBe(`-${WIDTH}px 0`)

      fireEvent.click(rowButton())
      expect(onRowClick).not.toHaveBeenCalled()
      expect(content.style.translate).toBe('')

      // Shut again: the row's own click works.
      fireEvent.click(rowButton())
      expect(onRowClick).toHaveBeenCalledTimes(1)
    })

    it('lets a plain tap on a shut row through', () => {
      const onRowClick = mock(() => {})
      render(row({ onRowClick }))
      pointer('pointerDown', rowButton(), 200, 20, 0)
      pointer('pointerUp', rowButton(), 200, 20, 50)
      fireEvent.click(rowButton())
      expect(onRowClick).toHaveBeenCalledTimes(1)
    })
  })

  it('shuts the open row when another one opens', () => {
    render(
      <>
        {row({ name: 'First' })}
        {row({ name: 'Second' })}
      </>,
    )
    const first = parts('First')
    const second = parts('Second')

    slowDrag(rowButton('First'), 300, 200)
    expect(first.content.style.translate).toBe(`-${WIDTH}px 0`)

    slowDrag(rowButton('Second'), 300, 200)
    expect(second.content.style.translate).toBe(`-${WIDTH}px 0`)
    expect(first.content.style.translate).toBe('')
    // Only the second row's actions are reachable now.
    expect(screen.getAllByRole('button', { name: 'Pin' })).toHaveLength(1)
  })

  it('shuts the open row as soon as another is grabbed, not only when it opens', () => {
    render(
      <>
        {row({ name: 'First' })}
        {row({ name: 'Second' })}
      </>,
    )
    const first = parts('First')
    slowDrag(rowButton('First'), 300, 200)
    pointer('pointerDown', rowButton('Second'), 300, 60, 0)
    pointer('pointerMove', rowButton('Second'), 280, 61, 100)
    expect(first.content.style.translate).toBe('')
  })

  it('shuts an open row when an ancestor scrolls', () => {
    render(
      <div data-testid="list" style={{ overflowY: 'auto' }}>
        {row()}
      </div>,
    )
    const { content } = parts()
    slowDrag(rowButton(), 300, 200)
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
    fireEvent.scroll(screen.getByTestId('list'))
    expect(content.style.translate).toBe('')
  })

  it('keeps an open row open when something that does not hold it scrolls', () => {
    render(
      <>
        <div data-testid="elsewhere" style={{ overflowY: 'auto' }} />
        {row()}
      </>,
    )
    const { content } = parts()
    slowDrag(rowButton(), 300, 200)
    fireEvent.scroll(screen.getByTestId('elsewhere'))
    expect(content.style.translate).toBe(`-${WIDTH}px 0`)
  })

  describe('disabled', () => {
    it('never opens', () => {
      render(row({ disabled: true }))
      const { content } = parts()
      slowDrag(rowButton(), 300, 150)
      expect(content.style.translate).toBe('')
      expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
      expect(tick).not.toHaveBeenCalled()
    })

    it('shuts a row that was open when a sheet opens over the list', () => {
      const { rerender } = render(row())
      const { content } = parts()
      slowDrag(rowButton(), 300, 200)
      expect(content.style.translate).toBe(`-${WIDTH}px 0`)

      rerender(row({ disabled: true }))
      expect(content.style.translate).toBe('')
      expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull()
    })
  })

  it('marks its root so the app edge swipe skips it', () => {
    render(row())
    const { root } = parts()
    expect(root.hasAttribute('data-swipe-ignore')).toBe(true)
    expect(root.hasAttribute('data-swipe-row')).toBe(true)
    // Only vertical panning is the browser's; the sideways drag is the row's.
    expect(root.className).toContain('touch-pan-y')
  })

  it('passes className to the root', () => {
    render(
      <SwipeRow actions={actionsFor(() => {}, () => {})} className="rounded-md">
        <button type="button">Session</button>
      </SwipeRow>,
    )
    expect(parts().root.className).toContain('rounded-md')
  })

  it('springs to rest when motion is allowed, instead of snapping', async () => {
    reduced = false
    render(row())
    const { content } = parts()
    pointer('pointerDown', rowButton(), 300, 20, 0)
    pointer('pointerMove', rowButton(), 200, 22, 100)
    pointer('pointerUp', rowButton(), 200, 22, 200)
    // Released at -92px: the spring has not run a frame yet.
    expect(content.style.translate).toBe('-92px 0')
    await waitFor(() => expect(content.style.translate).toBe(`-${WIDTH}px 0`))
  })
})

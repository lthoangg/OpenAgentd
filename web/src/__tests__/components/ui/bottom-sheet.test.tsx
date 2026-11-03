import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { BottomSheet } from '@/components/ui/bottom-sheet'

afterEach(cleanup)

const sheetNamed = (label: string) => document.querySelector<HTMLElement>(`[data-bottom-sheet][aria-label="${label}"]`)

/**
 * Wait for focus without a failing expect per poll: bun formats the DOM
 * element of each failed toBe into its message, which took most of a second
 * a time and timed the test out when the full suite loaded the machine.
 */
const focusLandsOn = (target: Element | null) => waitFor(() => {
  if (document.activeElement !== target) throw new Error('focus is elsewhere')
})

/** A one-finger pull through the given heights, starting on ``target``. */
function pull(target: Element, ys: number[]): TouchEvent[] {
  const at = (y: number) => [{ clientX: 100, clientY: y, target } as unknown as Touch]
  target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: at(ys[0]) }))
  const moves = ys.slice(1).map((y) => {
    const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: at(y) })
    target.dispatchEvent(move)
    return move
  })
  target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }))
  return moves
}

function PickerLike() {
  return (
    <>
      <div data-testid="models" style={{ overflowY: 'auto', maxHeight: 40 }}>
        <button type="button">model-a</button>
        <button type="button">model-b</button>
      </div>
      <button type="button">Account: Auto</button>
    </>
  )
}

describe('BottomSheet', () => {
  // Native sheets close from a pull anywhere on them, not only the handle.
  it('closes on a pull down from its content, the accounts under the list included', () => {
    const onClose = mock(() => {})
    render(
      <BottomSheet open onClose={onClose} label="Model and thinking">
        <PickerLike />
      </BottomSheet>,
    )
    const moves = pull(screen.getByText('Account: Auto'), [300, 310, 360, 420])
    expect(onClose).toHaveBeenCalledTimes(1)
    // The pull holds the page still rather than scrolling it.
    expect(moves.every((move) => move.defaultPrevented)).toBe(true)
  })

  it('lets a pull scroll a list back up first, and stays open', () => {
    const onClose = mock(() => {})
    render(
      <BottomSheet open onClose={onClose} label="Model and thinking">
        <PickerLike />
      </BottomSheet>,
    )
    const list = screen.getByTestId('models')
    list.scrollTop = 20
    const moves = pull(screen.getByText('model-b'), [300, 310, 360, 420])
    expect(onClose).not.toHaveBeenCalled()
    expect(moves.some((move) => move.defaultPrevented)).toBe(false)
  })

  it('stays open for a short pull let go, and leaves an upward swipe to the scroll', () => {
    const onClose = mock(() => {})
    render(
      <BottomSheet open onClose={onClose} label="Model and thinking">
        <PickerLike />
      </BottomSheet>,
    )
    pull(screen.getByText('Account: Auto'), [300, 330, 340, 330])
    // Let go short of the close distance, the sheet settles back in place.
    expect(sheetNamed('Model and thinking')?.style.translate).toBe('')
    const up = pull(screen.getByText('Account: Auto'), [300, 280, 200])
    expect(onClose).not.toHaveBeenCalled()
    expect(up.some((move) => move.defaultPrevented)).toBe(false)
  })

  // A native sheet never raises the on-screen keyboard as it opens: focus on
  // a search field would cover the list the user opened the sheet to see.
  it('opens with focus on the sheet, not on a text field inside it', async () => {
    render(
      <BottomSheet open onClose={() => {}} label="Model and thinking">
        <input aria-label="Search models" />
        <button type="button">fake-model</button>
      </BottomSheet>,
    )
    const sheet = sheetNamed('Model and thinking')
    expect(sheet?.getAttribute('role')).toBe('dialog')
    await focusLandsOn(sheet)
    expect(document.activeElement?.tagName).toBe('DIV')
  })

  it('still focuses the element it is asked to', async () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(
      <BottomSheet open onClose={() => {}} label="Add to message" initialFocus={ref}>
        <input aria-label="Search" />
        <button type="button" ref={ref}>Attach file</button>
      </BottomSheet>,
    )
    const attach = screen.getByText('Attach file')
    await focusLandsOn(attach)
    expect(document.activeElement?.textContent).toBe('Attach file')
  })

  // The composer is a size container; older WebKit and Chromium make a
  // container the box a fixed child is placed in, so a sheet left inside it
  // sat in the composer and its backdrop dimmed only the composer.
  it('renders at the top of the document, outside the container it is opened from', () => {
    render(
      <div data-testid="composer" style={{ containerType: 'inline-size' }}>
        <BottomSheet open onClose={() => {}} label="Model and thinking">
          <button type="button">fake-model</button>
        </BottomSheet>
      </div>,
    )
    const sheet = sheetNamed('Model and thinking')
    expect(sheet).not.toBeNull()
    expect(screen.getByTestId('composer').contains(sheet)).toBe(false)
    expect(sheet?.parentElement).toBe(document.body)
  })
})

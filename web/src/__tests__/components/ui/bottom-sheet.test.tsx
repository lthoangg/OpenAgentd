import { afterEach, describe, expect, it } from 'bun:test'
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

describe('BottomSheet', () => {
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

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { BottomSheet } from '@/components/ui/bottom-sheet'

afterEach(cleanup)

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
    const sheet = screen.getByRole('dialog', { name: 'Model and thinking' })
    await waitFor(() => expect(document.activeElement).toBe(sheet))
    expect(screen.getByRole('textbox', { name: 'Search models' })).not.toHaveFocus()
  })

  it('still focuses the element it is asked to', async () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(
      <BottomSheet open onClose={() => {}} label="Add to message" initialFocus={ref}>
        <input aria-label="Search" />
        <button type="button" ref={ref}>Attach file</button>
      </BottomSheet>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach file' })).toHaveFocus())
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
    const sheet = screen.getByRole('dialog', { name: 'Model and thinking' })
    expect(screen.getByTestId('composer').contains(sheet)).toBe(false)
    expect(sheet.parentElement).toBe(document.body)
  })
})

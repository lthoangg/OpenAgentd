/**
 * The run deck's context ring and the numbers behind it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ContextMeter } from '@/components/composer/ContextMeter'

afterEach(cleanup)

describe('ContextMeter', () => {
  it('sets its labels in the UI font and only the numbers in mono, as the turn details do', () => {
    render(<ContextMeter input={1000} output={1600} cachedPercent={40} trigger={50000} canSummarize />)
    fireEvent.click(screen.getByRole('button', { name: /^Context 2% full/ }))

    for (const name of ['Context', 'Output', 'Cached']) {
      const label = screen.getByText(name)
      expect(label.tagName).toBe('DT')
      expect(label.closest('.font-mono')).toBeNull()
      expect((label.nextElementSibling as HTMLElement).className).toContain('font-mono')
    }
  })

  it('shows no cost: spend lives on the answer footer (per turn) and the status bar (24h)', () => {
    render(<ContextMeter input={1000} output={1600} trigger={50000} canSummarize />)
    fireEvent.click(screen.getByRole('button', { name: /^Context 2% full/ }))

    expect(screen.queryByText(/spend|cost/i)).toBeNull()
    expect(screen.queryByText(/\$\d/)).toBeNull()
  })
})

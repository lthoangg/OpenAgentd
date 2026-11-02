/**
 * The run deck's context ring and the numbers behind it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ContextMeter } from '@/components/composer/ContextMeter'

afterEach(cleanup)

describe('ContextMeter', () => {
  it('sets its labels in the UI font and only the numbers in mono, as the turn details do', () => {
    render(<ContextMeter input={1000} output={1600} sessionCostUsd={0.09} trigger={50000} canSummarize />)
    fireEvent.click(screen.getByRole('button', { name: /^Context 2% full/ }))

    for (const name of ['Context', 'Output', 'Spend (est.)']) {
      const label = screen.getByText(name)
      expect(label.tagName).toBe('DT')
      expect(label.closest('.font-mono')).toBeNull()
      expect((label.nextElementSibling as HTMLElement).className).toContain('font-mono')
    }
  })
})

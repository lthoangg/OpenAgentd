/**
 * The run deck's context ring and the numbers behind it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ContextMeter } from '@/components/composer/ContextMeter'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
})

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

  it("shows the session's cost, the label in the UI font and the amount in mono", () => {
    render(<ContextMeter input={1000} output={1600} trigger={50000} sessionCostUsd={0.4237} canSummarize />)
    fireEvent.click(screen.getByRole('button', { name: /^Context 2% full/ }))

    const label = screen.getByText('Cost')
    expect(label.tagName).toBe('DT')
    expect(label.nextElementSibling?.textContent).toBe('$0.42')
    expect((label.nextElementSibling as HTMLElement).className).toContain('font-mono')
  })

  it('leaves the cost out when nothing was priced: an unpriced model reads $0, which would mislead', () => {
    for (const cost of [undefined, 0]) {
      render(<ContextMeter input={1000} output={1600} trigger={50000} sessionCostUsd={cost} canSummarize />)
      fireEvent.click(screen.getByRole('button', { name: /^Context 2% full/ }))
      expect(screen.queryByText('Cost')).toBeNull()
      expect(screen.queryByText(/\$\d/)).toBeNull()
      cleanup()
    }
  })

  it('in Full shows the ring from the first message, with a bare percentage', () => {
    render(<ContextMeter input={1000} output={10} trigger={50000} canSummarize />)
    expect(screen.getByRole('button', { name: /^Context 2% full/ }).textContent).toBe('2%')
  })

  it('in Simple shows the ring from the first message, with a bare percentage, as in Full', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })

    render(<ContextMeter input={1000} output={10} trigger={50000} canSummarize />)
    const ring = screen.getByRole('button', { name: /^Context 2% full/ })
    expect(ring.textContent).toBe('2%')

    // The numbers and Summarize now are behind it, as in Full.
    fireEvent.click(ring)
    expect(screen.getByRole('button', { name: 'Summarize now' })).toBeTruthy()
  })
})

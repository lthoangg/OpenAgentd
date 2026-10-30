import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { MetaRow, formatMetaDuration } from '@/components/ui/meta-row'
import { Term, TERMS } from '@/components/ui/term'

afterEach(cleanup)

describe('Chip', () => {
  it('always carries its text, with the tone exposed for styling', () => {
    render(<Chip tone="error" mono>exit 1</Chip>)
    const chip = screen.getByText('exit 1').closest('[data-slot="chip"]')!
    expect(chip.getAttribute('data-tone')).toBe('error')
    expect(chip.className).toContain('font-mono')
  })
})

describe('Term', () => {
  it('keeps the technical word and describes it with its definition', () => {
    render(<Term definition="ttft">TTFT</Term>)
    const term = screen.getByText('TTFT')
    expect(term.getAttribute('aria-describedby')).toBeTruthy()
    expect(TERMS.ttft).toContain('first streamed token')
  })
})

describe('MetaRow', () => {
  it('renders a plain div without details so it adds no tab stop', () => {
    render(<MetaRow meta="33 ms"><span>read</span></MetaRow>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('33 ms')).toBeTruthy()
  })

  it('renders a button when it opens details', () => {
    render(<MetaRow as="button" aria-expanded={false} meta="2.4 s"><span>shell</span></MetaRow>)
    expect(screen.getByRole('button').textContent).toContain('2.4 s')
  })

  it('formats durations in ms under a second, then seconds, then minutes', () => {
    expect(formatMetaDuration(33)).toBe('33 ms')
    expect(formatMetaDuration(2400)).toBe('2.4 s')
    expect(formatMetaDuration(125_000)).toBe('2m 05s')
  })
})

describe('ConfirmDialog', () => {
  it('runs the action only after the user confirms, then closes', async () => {
    const user = userEvent.setup()
    const onConfirm = mock(() => Promise.resolve())
    const onOpenChange = mock((..._args: unknown[]) => {})
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Stop the built-in server?"
        description="Running agents stop."
        confirmLabel="Stop server"
        onConfirm={onConfirm}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)

    await user.click(screen.getByRole('button', { name: 'Stop server' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

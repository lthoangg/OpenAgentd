/**
 * RevertNotice — the notice after Undo: one container, the caption in words
 * (Undo / Redo, what happens next), one row of actions, no box inside a box.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RevertNotice } from '@/components/RevertNotice'
import { TRANSCRIPT_CARD } from '@/components/ui/panel-tokens'

afterEach(cleanup)

describe('RevertNotice', () => {
  it('renders nothing when nothing is undone', () => {
    const { container } = render(<RevertNotice count={0} onRedo={() => {}} />)

    expect(container.innerHTML).toBe('')
  })

  it('says what is undone and what happens next, as visible text', () => {
    const { unmount } = render(<RevertNotice count={2} onRedo={() => {}} onRedoAll={() => {}} />)
    expect(screen.getByText('Undid the last 2 messages. Redo brings them back; sending a new message discards them.')).toBeTruthy()
    unmount()

    render(<RevertNotice count={1} onRedo={() => {}} />)
    expect(screen.getByText('Undid the last message. Redo brings it back; sending a new message discards it.')).toBeTruthy()
  })

  it('words the caption with Undo and Redo, not "undone"', () => {
    render(<RevertNotice count={2} onRedo={() => {}} />)

    expect(screen.getByText(/^Undid the last 2 messages/).textContent).not.toMatch(/undone/i)
  })

  it('uses one word pair, Undo and Redo, and never "revert"', () => {
    const { container } = render(<RevertNotice count={3} messages={[{ role: 'user', content: 'a' }]} onRedo={() => {}} onRedoAll={() => {}} />)

    expect(container.textContent).not.toMatch(/revert/i)
    expect(screen.getByRole('button', { name: 'Redo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Redo all' })).toBeTruthy()
  })

  it('calls onRedo when clicking "Redo"', async () => {
    const user = userEvent.setup()
    const onRedo = mock(() => {})

    render(<RevertNotice count={1} messages={[{ role: 'user', content: 'undone draft' }]} onRedo={onRedo} />)

    await user.click(screen.getByRole('button', { name: 'Redo' }))

    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('adds Redo all only when more than one message is undone', () => {
    const { unmount } = render(<RevertNotice count={1} onRedo={() => {}} onRedoAll={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Redo all' })).toBeNull()
    unmount()

    render(<RevertNotice count={2} onRedo={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Redo all' })).toBeNull()
  })

  it('calls onRedoAll when clicking "Redo all"', async () => {
    const user = userEvent.setup()
    const onRedo = mock(() => {})
    const onRedoAll = mock(() => {})

    render(
      <RevertNotice
        count={2}
        messages={[
          { role: 'user', content: 'draft 1' },
          { role: 'user', content: 'draft 2' },
        ]}
        onRedo={onRedo}
        onRedoAll={onRedoAll}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Redo all' }))

    expect(onRedoAll).toHaveBeenCalledTimes(1)
    expect(onRedo).not.toHaveBeenCalled()
  })

  it('adds detail in a tooltip on Redo, on top of the caption that already says it', async () => {
    const user = userEvent.setup()
    render(<RevertNotice count={2} onRedo={() => {}} onRedoAll={() => {}} />)

    await user.hover(screen.getByRole('button', { name: 'Redo' }))

    expect((await screen.findByRole('tooltip')).textContent).toContain('last message you undid')
  })

  it('shows the undone messages on request, under the row of actions', async () => {
    const user = userEvent.setup()
    render(
      <RevertNotice
        count={2}
        messages={[
          { role: 'user', content: 'draft 1' },
          { role: 'user', content: 'draft 2' },
        ]}
        onRedo={() => {}}
        onRedoAll={() => {}}
      />,
    )
    expect(screen.queryByText('draft 1')).toBeNull()

    const toggle = screen.getByRole('button', { name: 'Show messages' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)

    expect(screen.getByRole('button', { name: 'Hide messages' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('list', { name: 'Messages you undid' }).textContent).toContain('draft 1')
    expect(screen.getByText('draft 2')).toBeTruthy()
  })

  it('has no toggle when there are no messages to show', () => {
    render(<RevertNotice count={2} onRedo={() => {}} onRedoAll={() => {}} />)

    expect(screen.queryByRole('button', { name: /show messages/i })).toBeNull()
  })

  it('is one container with one thin frame, and no box or border inside it', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RevertNotice count={2} messages={[{ role: 'user', content: 'draft 1' }, { role: 'user', content: 'draft 2' }]} onRedo={() => {}} onRedoAll={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: 'Show messages' }))

    const frame = screen.getByText(/Undid the last 2 messages/).parentElement as HTMLElement
    expect(frame.className).toContain('border-(--color-border-subtle)')
    // The transcript's one card token: rounded-sm, not rounded-md.
    for (const token of TRANSCRIPT_CARD.split(' ')) expect(frame.className.split(/\s+/)).toContain(token)
    expect(frame.className).not.toContain('rounded-md')
    const bordered = Array.from(container.querySelectorAll('*')).filter((el) => /(?<![\w-:])border(?:-[btlrxy])?(?![\w-])/.test(el.getAttribute('class') ?? ''))
    expect(bordered).toEqual([frame])
  })

  it('reads the caption at 12px and keeps its actions on one row', () => {
    render(<RevertNotice count={2} messages={[{ role: 'user', content: 'a' }]} onRedo={() => {}} onRedoAll={() => {}} />)

    expect(screen.getByText(/Undid the last 2 messages/).className).toContain('leading-relaxed')
    expect(screen.getByText(/Undid the last 2 messages/).parentElement?.className).toContain('text-xs')
    const row = screen.getByRole('button', { name: 'Redo' }).closest('div') as HTMLElement
    expect(Array.from(row.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Redo', 'Redo all', 'Show messages'])
  })
})

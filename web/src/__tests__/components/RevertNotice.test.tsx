import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RevertNotice } from '@/components/RevertNotice'

describe('RevertNotice', () => {
  it('calls onRedo when clicking "Redo"', async () => {
    const user = userEvent.setup()
    const onRedo = mock(() => {})

    render(
      <RevertNotice
        count={1}
        messages={[{ role: 'user', content: 'undone draft' }]}
        onRedo={onRedo}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Redo next message' }))

    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('explains that Redo restores only the next undone message', async () => {
    const user = userEvent.setup()
    render(<RevertNotice count={2} onRedo={() => {}} onRedoAll={() => {}} />)

    await user.hover(screen.getByRole('button', { name: 'Redo next message' }))

    expect((await screen.findByRole('tooltip')).textContent).toContain('next undone message')
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
})

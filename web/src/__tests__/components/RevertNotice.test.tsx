import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RevertNotice } from '@/components/RevertNotice'

describe('RevertNotice', () => {
  it('calls onRedo when clicking "/redo to restore"', async () => {
    const user = userEvent.setup()
    const onRedo = mock(() => {})

    render(
      <RevertNotice
        count={1}
        messages={[{ role: 'user', content: 'undone draft' }]}
        onRedo={onRedo}
      />,
    )

    await user.click(screen.getByRole('button', { name: '/redo to restore' }))

    expect(onRedo).toHaveBeenCalledTimes(1)
  })

  it('calls onRedoAll when clicking "/redo-all"', async () => {
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

    await user.click(screen.getByRole('button', { name: '/redo-all' }))

    expect(onRedoAll).toHaveBeenCalledTimes(1)
    expect(onRedo).not.toHaveBeenCalled()
  })
})

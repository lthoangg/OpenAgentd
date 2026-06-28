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
})

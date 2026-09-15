import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { WorkspaceBadge } from '@/components/SchedulerPanel/ModeBadge'
import { setChatWorkspaceEntry } from '@/utils/workspace'

afterEach(() => {
  cleanup()
  setChatWorkspaceEntry(null)
})

describe('WorkspaceBadge', () => {
  it('labels a task bound to the chat root as Chat without leaking the home path', async () => {
    const user = userEvent.setup()
    setChatWorkspaceEntry({ path: '/Users/name', name: 'Chat' })

    render(<WorkspaceBadge task={{ workspace: '/Users/name' }} />)

    expect(screen.getByText('Chat')).toBeInTheDocument()

    await user.hover(screen.getByText('Chat'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Chat workspace')
    expect(screen.queryByText('/Users/name')).not.toBeInTheDocument()
  })

  it('keeps revealing the real path for coding workspaces', async () => {
    const user = userEvent.setup()

    render(<WorkspaceBadge task={{ workspace: '/repo/app' }} />)

    expect(screen.getByText('app')).toBeInTheDocument()

    await user.hover(screen.getByText('app'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('/repo/app')
  })
})

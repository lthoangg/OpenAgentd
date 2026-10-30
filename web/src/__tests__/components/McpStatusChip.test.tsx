import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { McpStatusChip } from '@/components/McpStatusChip'
import type { ServerStatus } from '@/api/client'

afterEach(cleanup)

function server(state: ServerStatus['state'], over: Partial<ServerStatus> = {}): ServerStatus {
  return { name: 'github', transport: 'stdio', enabled: true, state, error: null, tool_names: [], started_at: null, config: null, ...over }
}

describe('McpStatusChip', () => {
  it('says a server needs sign-in in words, with the raw state one hover away', () => {
    render(<McpStatusChip server={server('auth_required')} />)
    const chip = screen.getByText('Needs sign-in').closest('[data-slot=chip]') as HTMLElement
    expect(chip.dataset.tone).toBe('warning')
    expect(chip.getAttribute('title')).toBe('state: auth_required')
  })

  it('keeps a failure reason in the tooltip', () => {
    render(<McpStatusChip server={server('error', { error: 'spawn npx ENOENT' })} />)
    const chip = screen.getByText('Error').closest('[data-slot=chip]') as HTMLElement
    expect(chip.dataset.tone).toBe('error')
    expect(chip.getAttribute('title')).toBe('state: error · spawn npx ENOENT')
  })

  it('counts the tools of a ready server', () => {
    render(<McpStatusChip server={server('ready', { tool_names: ['a', 'b'] })} />)
    expect(screen.getByText('Ready · 2 tools')).toBeTruthy()
  })

  it('says Off for a disabled server whatever its last state', () => {
    render(<McpStatusChip server={server('auth_required', { enabled: false })} />)
    expect(screen.getByText('Off')).toBeTruthy()
  })
})

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { McpStatusDot } from '@/components/McpStatusDot'
import type { ServerStatus } from '@/api/client'

afterEach(cleanup)

function server(state: ServerStatus['state'], error: string | null = null): ServerStatus {
  return { name: 'github', transport: 'stdio', enabled: true, state, error, tool_names: [], started_at: null, config: null }
}

describe('McpStatusDot', () => {
  it('exposes the state to screen readers as a labelled image in plain words', () => {
    render(<McpStatusDot server={server('auth_required')} />)
    expect(screen.getByRole('img', { name: 'Sign-in required' })).toBeTruthy()
  })

  it('names a failure with its error, without a raw "Error:" prefix', () => {
    render(<McpStatusDot server={server('error', 'spawn npx ENOENT')} />)
    expect(screen.getByRole('img', { name: 'Failed: spawn npx ENOENT' })).toBeTruthy()
  })

  it('keeps the state colour on the dot', () => {
    render(<McpStatusDot server={server('ready')} />)
    expect(screen.getByRole('img', { name: 'Ready' }).className).toContain('bg-(--accent-green)')
  })
})

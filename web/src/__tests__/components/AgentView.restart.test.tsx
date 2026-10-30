/**
 * A server restart in the transcript: the note it leaves reads as a divider
 * (the agent reads its text, the user never wrote it), and it is never
 * taken for one of the user's prompts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { composerHistoryPrompts } from '@/components/AgentChatView/helpers'
import { restoredPromptText } from '@/lib/goal'
import { isPromptMessage } from '@/utils/messages'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock, MessageResponse } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

const NOTE = 'The server restarted while you were working, which cut off your last step.'

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'run the tests' },
  { id: 'a1', type: 'text', content: 'Running them now.' },
  { id: 'u2', type: 'user', content: NOTE, extra: { restart_resume: { continued: true } } },
  { id: 'a2', type: 'text', content: 'The server restarted, so I ran them again.' },
]

describe('AgentView — restart notes', () => {
  it('shows a continued turn as a divider, not as the user’s words', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByRole('note', { name: 'Server restarted · turn continued' }).textContent).toBe('Server restarted · turn continued')
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('says when a second restart left the turn stopped', () => {
    const stopped: ContentBlock = { id: 'u3', type: 'user', content: 'not continued', extra: { restart_resume: { continued: false } } }
    render(<AgentView blocks={[...BLOCKS, stopped]} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByRole('note', { name: 'Server restarted · turn stopped' })).toBeTruthy()
  })

  it('never counts the note as a prompt the user wrote', () => {
    expect(composerHistoryPrompts(BLOCKS)).toEqual(['run the tests'])
    expect(restoredPromptText(NOTE, { restart_resume: { continued: true } })).toBeNull()
    const row = { id: 'm2', role: 'user', kind: 'chat', content: NOTE, extra: { restart_resume: { continued: true } } } as unknown as MessageResponse
    expect(isPromptMessage(row)).toBe(false)
    expect(isPromptMessage({ ...row, extra: null })).toBe(true)
  })
})

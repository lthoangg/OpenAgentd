/**
 * The "about to respond" dots — the only feedback between an action and the
 * first token of the reply.
 *
 * Three situations produce them, and the third is easy to lose: a turn resumed
 * after an answered ``ask_user`` adds no user block, and ``currentBlocks`` still
 * holds the turn it is resuming, so both of the other conditions read it as a
 * finished turn and the UI looks frozen until the model answers.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

const DOTS = /is preparing a response/i

/** What the transcript holds while a lead is suspended on a question. */
const SUSPENDED_TURN: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Set the project up' },
  { id: 't1', type: 'text', content: 'I need one decision first.' },
  { id: 'k1', type: 'tool', content: '', toolName: 'ask_user', toolDone: true },
]

function renderView(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      blocks={props.blocks ?? []}
      currentBlocks={props.currentBlocks ?? []}
      isWorking={props.isWorking ?? false}
      isTurnOpen={props.isTurnOpen}
      isAwaitingRestart={props.isAwaitingRestart}
      isError={props.isError}
      lastError={props.lastError}
    />,
  )
}

describe('AgentView — pending dots', () => {
  it('shows dots while a sent message waits for the agent to wake', () => {
    renderView({ currentBlocks: [{ id: 'u1', type: 'user', content: 'Hi' }] })

    expect(screen.getByRole('status', { name: DOTS })).toBeDefined()
  })

  it('shows dots while working before any agent content arrives', () => {
    renderView({
      isWorking: true,
      currentBlocks: [{ id: 'u1', type: 'user', content: 'Hi' }],
    })

    expect(screen.getByRole('status', { name: DOTS })).toBeDefined()
  })

  it('hides dots once the agent has produced content', () => {
    renderView({
      isWorking: true,
      currentBlocks: [
        { id: 'u1', type: 'user', content: 'Hi' },
        { id: 't1', type: 'text', content: 'Working on it' },
      ],
    })

    expect(screen.queryByRole('status', { name: DOTS })).toBeNull()
  })

  it('shows no dots while the lead sits suspended on a question', () => {
    // Waiting on the user is not "about to respond" — the card is the thing
    // asking, and bouncing dots under it would claim work is happening.
    renderView({ isTurnOpen: true, currentBlocks: SUSPENDED_TURN })

    expect(screen.queryByRole('status', { name: DOTS })).toBeNull()
  })

  it('shows dots on the turn restarted by an answered question', () => {
    // The regression this flag exists for: no new user block, and the old turn
    // is still on screen, so neither other condition fires.
    renderView({
      isWorking: true,
      isTurnOpen: true,
      isAwaitingRestart: true,
      currentBlocks: SUSPENDED_TURN,
    })

    expect(screen.getByRole('status', { name: DOTS })).toBeDefined()
  })

  it('shows no dots for a resumed turn that has started producing', () => {
    renderView({
      isWorking: true,
      isTurnOpen: true,
      isAwaitingRestart: false,
      currentBlocks: [...SUSPENDED_TURN, { id: 't2', type: 'text', content: 'Using pnpm.' }],
    })

    expect(screen.queryByRole('status', { name: DOTS })).toBeNull()
  })
})

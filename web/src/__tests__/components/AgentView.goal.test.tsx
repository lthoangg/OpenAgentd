/**
 * `/goal` in the transcript: the objective carries a badge, a turn the goal
 * started on its own reads as a divider (not a prompt the user wrote), and
 * prompt navigation skips it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { composerHistoryPrompts } from '@/components/AgentChatView/helpers'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
})

const REMINDER = '<goal_reminder turn="2" max_turns="50" tokens_used="1200">\nContinue working toward the session goal.\n</goal_reminder>'

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'web tests pass', extra: { goal: { id: 'g1' } } },
  { id: 'a1', type: 'text', content: 'Fixed the reducer.' },
  { id: 'u2', type: 'user', content: REMINDER, extra: { goal_turn: { id: 'g1', turn: 2, max_turns: 50 } } },
  { id: 'a2', type: 'text', content: 'Ran the suite.' },
]

describe('AgentView — goal markers', () => {
  it('badges the objective and shows a continuation as a divider', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    expect(container.querySelector('[data-goal-objective]')?.textContent).toContain('Goal set')
    const divider = screen.getByRole('separator', { name: 'Goal continues: turn 2 of 50' })
    expect(divider.textContent).toBe('Goal · turn 2 of 50')
    // The hidden reminder is never shown as the user's words.
    expect(screen.queryByText(/goal_reminder/)).toBeNull()
  })

  it("marks the goal's last allowed turn", () => {
    const last: ContentBlock = { id: 'u3', type: 'user', content: REMINDER, extra: { goal_turn: { id: 'g1', turn: 50, max_turns: 50 } } }
    render(<AgentView blocks={[...BLOCKS, last]} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByRole('separator', { name: 'Goal continues: turn 50 of 50, the last one' }).textContent).toBe('Goal · turn 50 of 50 · last')
  })

  it('shows the goal markers and the achieved card in reader mode, with the work folded', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    const blocks: ContentBlock[] = [
      ...BLOCKS.slice(0, 3),
      { id: 't1', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"bun test"}', toolDone: true, toolResult: '0 failures' },
      {
        id: 't2', type: 'tool', content: '', toolName: 'update_goal', toolArgs: '{"status":"complete","evidence":"bun test: 0 failures"}',
        toolDone: true, toolResult: 'The check confirmed the goal is met: The run shows 0 failures.\nThe goal is achieved.',
      },
      { id: 'a2', type: 'text', content: 'All green.' },
    ]
    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(container.querySelector('[data-goal-objective]')).not.toBeNull()
    expect(screen.getByRole('separator', { name: 'Goal continues: turn 2 of 50' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Goal achieved' }).textContent).toContain('The run shows 0 failures.')
    expect(screen.getByRole('button', { name: /^1 command/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps continuations out of prompt navigation and composer history', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const prompts = [...container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((el) => el.dataset.promptId)
    expect(prompts).toEqual(['u1'])
    expect(composerHistoryPrompts(BLOCKS)).toEqual(['web tests pass'])
  })
})

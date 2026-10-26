/**
 * A goal in the transcript: a turn the goal started on its own reads as a
 * divider (not a prompt the user wrote) that says why the goal went on, and
 * prompt navigation skips it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
  { id: 'u1', type: 'user', content: 'web tests pass' },
  { id: 'a1', type: 'text', content: 'Fixed the reducer.' },
  { id: 'u2', type: 'user', content: REMINDER, extra: { goal_turn: { id: 'g1', turn: 2, max_turns: 50, why: 'unclaimed', tokens_used: 1200 } } },
  { id: 'a2', type: 'text', content: 'Ran the suite.' },
]

const REJECTED: ContentBlock = {
  id: 'u3',
  type: 'user',
  content: REMINDER,
  extra: { goal_turn: { id: 'g1', turn: 3, max_turns: 50, why: 'rejected', check: 'No `bun test` run after the last patch is shown.', tokens_used: 412_000 } },
}

describe('AgentView — goal markers', () => {
  it('shows a continuation as a divider that says why', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const divider = screen.getByRole('group', { name: 'Goal continues: turn 2 of 50' })
    expect(divider.textContent).toBe('Goal · turn 2 of 50 · not done yet')
    // The hidden reminder is never shown as the user's words.
    expect(screen.queryByText(/goal_reminder/)).toBeNull()
  })

  it("opens the check's reason when the divider is pressed, as touch has no hover", () => {
    render(<AgentView blocks={[...BLOCKS, REJECTED]} currentBlocks={[]} isWorking={false} />)

    const divider = screen.getByRole('group', { name: 'Goal continues: turn 3 of 50' })
    const toggle = divider.querySelector('button')!
    expect(toggle.textContent).toBe('Goal · turn 3 of 50 · check said not yet')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const reason = divider.querySelector('[data-goal-turn-reason]')!
    // The check's own words, nothing around them.
    expect(reason.textContent).toBe('No bun test run after the last patch is shown.')
  })

  it('shows why on hover', async () => {
    const user = userEvent.setup()
    render(<AgentView blocks={[...BLOCKS, REJECTED]} currentBlocks={[]} isWorking={false} />)

    await user.hover(screen.getByRole('button', { name: /turn 3 of 50/ }))

    const tip = await screen.findByRole('tooltip', undefined, { timeout: 2000 })
    expect(tip.textContent).toBe('No bun test run after the last patch is shown.')
  })

  it("marks the goal's last allowed turn", () => {
    const last: ContentBlock = { id: 'u3', type: 'user', content: REMINDER, extra: { goal_turn: { id: 'g1', turn: 50, max_turns: 50 } } }
    render(<AgentView blocks={[...BLOCKS, last]} currentBlocks={[]} isWorking={false} />)

    // A turn from before the reason was recorded has no reason in its label.
    expect(screen.getByRole('group', { name: 'Goal continues: turn 50 of 50, the last one' }).textContent).toBe('Goal · turn 50 of 50 · last')
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
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByRole('group', { name: 'Goal continues: turn 2 of 50' }).textContent).toBe('Goal · turn 2 of 50 · not done yet')
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

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'
import { TitleTooltipLayer } from '@/components/ui/title-tooltip'

const revertToMessage = mock(async () => null)
const initialRevertToMessage = useAgentStore.getState().revertToMessage

beforeEach(() => {
  revertToMessage.mockClear()
  useAgentStore.setState({ sessionId: 'session-1', revertToMessage })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [], revertToMessage: initialRevertToMessage })
})

const BLOCKS: ContentBlock[] = [
  { id: 'm1', type: 'user', content: 'first prompt' },
  { id: 'a1', type: 'text', content: 'first answer' },
  { id: 'r1', type: 'user', content: 'report', extra: { from_agent: 'explorer' } },
  { id: 'm2', type: 'user', content: 'second prompt' },
  { id: 'a2', type: 'text', content: 'second answer' },
]

describe('AgentView — edit any prompt', () => {
  it('offers Edit on every prompt the user wrote, and rewinds to the one clicked', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const edits = screen.getAllByRole('button', { name: 'Edit prompt' })
    expect(edits).toHaveLength(2)

    fireEvent.click(edits[0])
    expect(revertToMessage).toHaveBeenCalledWith('m1')
  })

  it('shows Edit disabled while a turn is open, with the reason on its tooltip', async () => {
    const user = userEvent.setup()
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} isTurnOpen />)

    expect(screen.queryByRole('button', { name: 'Edit prompt' })).toBeNull()
    const edits = screen.getAllByRole('button', { name: /Edit prompt, available when this turn ends/ })
    expect(edits).toHaveLength(2)
    expect(edits[0].getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(edits[0])
    expect(revertToMessage).not.toHaveBeenCalled()

    // The reason is a title, drawn by the app's title layer.
    render(<TitleTooltipLayer />)
    await user.hover(edits[0])
    expect((await screen.findByRole('tooltip')).textContent).toBe('Available when this turn ends')
  })

  it('hides the prompt row at rest on every prompt, the latest too, and shows it on hover, focus and touch', async () => {
    const user = userEvent.setup()
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const rowOf = (button: HTMLElement) => button.closest('div') as HTMLElement
    const [firstEdit, lastEdit] = screen.getAllByRole('button', { name: 'Edit prompt' })
    const [firstCopy, lastCopy] = screen.getAllByRole('button', { name: 'Copy prompt' })
    expect(rowOf(firstCopy)).toBe(rowOf(firstEdit))
    expect(rowOf(lastCopy)).toBe(rowOf(lastEdit))

    for (const edit of [firstEdit, lastEdit]) {
      // Desktop: hidden at rest, the latest prompt too (it no longer keeps its row out).
      expect(rowOf(edit).className).toContain('opacity-0')
      // Shown for keyboard focus, and always on touch (no hover there).
      expect(rowOf(edit).className).toContain('focus-within:opacity-100')
      expect(rowOf(edit).className).toContain('pointer-coarse:opacity-100')
    }

    // Hovering the prompt's text shows its row (the region is the prompt and its row)...
    await user.hover(screen.getByText('second prompt'))
    expect(rowOf(lastEdit).className).toContain('opacity-100')
    expect(rowOf(lastEdit).className).not.toContain('opacity-0')
    // ...only that prompt's, and it hides again when the pointer leaves.
    expect(rowOf(firstEdit).className).toContain('opacity-0')
    await user.unhover(screen.getByText('second prompt'))
    expect(rowOf(lastEdit).className).toContain('opacity-0')

    // Hovering the row itself keeps it shown.
    await user.hover(lastEdit)
    expect(rowOf(lastEdit).className).toContain('opacity-100')
  })
})

describe('AgentView — retry', () => {
  it('keeps Retry to the error card; a finished answer has none', () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Retry response' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

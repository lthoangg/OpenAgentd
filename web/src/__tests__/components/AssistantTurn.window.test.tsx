import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantTurn, TURN_BLOCK_WINDOW } from '@/components/AssistantTurnFooter'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true, writable: true })
})
afterEach(cleanup)

const textBlocks = (n: number): ContentBlock[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, type: 'text', content: `step ${i}` }))
const W = TURN_BLOCK_WINDOW

function renderTurn(blocks: ContentBlock[], reader = false) {
  return render(
    <AssistantTurn
      blocks={blocks}
      startIndex={0}
      finalizedCount={blocks.length}
      isWorking={false}
      isTrailingTurn
      totalBlocks={blocks.length}
      reader={reader}
      renderBlock={({ block }) => <div data-testid="block">{block.content}</div>}
    />,
  )
}

describe('AssistantTurn — long-turn window', () => {
  it('renders the newest steps and reveals earlier ones on request', () => {
    renderTurn(textBlocks(2 * W + 50))
    expect(screen.getAllByTestId('block')).toHaveLength(W)
    expect(screen.getByText(`step ${2 * W + 49}`)).toBeTruthy()
    expect(screen.queryByText(`step ${W + 49}`)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Show ${W + 50} earlier steps` }))
    expect(screen.getAllByTestId('block')).toHaveLength(2 * W)
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 earlier steps' }))
    expect(screen.getAllByTestId('block')).toHaveLength(2 * W + 50)
    expect(screen.queryByRole('button', { name: /earlier step/ })).toBeNull()
  })

  it('shows no expander for a short turn', () => {
    renderTurn(textBlocks(W))
    expect(screen.getAllByTestId('block')).toHaveLength(W)
    expect(screen.queryByRole('button', { name: /earlier step/ })).toBeNull()
  })

  it('windows reader-mode segments too', () => {
    renderTurn(textBlocks(W + 50), true)
    expect(screen.getByRole('button', { name: 'Show 50 earlier steps' })).toBeTruthy()
    expect(screen.queryByText('step 49')).toBeNull()
    expect(screen.getByText(`step ${W + 49}`)).toBeTruthy()
  })
})

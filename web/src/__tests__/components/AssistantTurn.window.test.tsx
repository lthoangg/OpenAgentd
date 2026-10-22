import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { AssistantTurn } from '@/components/AssistantTurnFooter'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true, writable: true })
})
afterEach(cleanup)

const textBlocks = (n: number): ContentBlock[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, type: 'text', content: `step ${i}` }))

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

describe('AssistantTurn — long turns', () => {
  it('renders every step of a long turn with no expander', () => {
    renderTurn(textBlocks(1000))
    expect(screen.getAllByTestId('block')).toHaveLength(1000)
    expect(screen.getByText('step 0')).toBeTruthy()
    expect(screen.getByText('step 999')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /earlier step/ })).toBeNull()
  })

  it('renders every step in reader mode too', () => {
    renderTurn(textBlocks(1000), true)
    expect(screen.getByText('step 0')).toBeTruthy()
    expect(screen.getByText('step 999')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /earlier step/ })).toBeNull()
  })
})

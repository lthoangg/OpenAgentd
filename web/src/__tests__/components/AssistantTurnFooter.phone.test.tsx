/**
 * On a phone the turn's details open as a sheet from a 44pt trigger (mockup J4).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { AssistantTurnFooter } = await import('@/components/AssistantTurnFooter')

afterEach(cleanup)

describe('AssistantTurnFooter on a phone', () => {
  it('opens Turn details in a sheet', () => {
    render(
      <AssistantTurnFooter
        turnBlocks={[{ id: 'a1', type: 'text', content: 'Done.', timestamp: new Date('2026-01-01T00:00:00Z'), responseDurationMs: 1200 } as never]}
      />,
    )
    const trigger = screen.getByRole('button', { name: /^Turn details/ })
    expect(trigger.className).toContain('min-h-11')
    fireEvent.click(trigger)
    expect(document.querySelector('[data-turn-details-sheet]')).not.toBeNull()
  })
})

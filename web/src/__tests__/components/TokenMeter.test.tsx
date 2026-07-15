import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TokenMeter } from '@/components/ui/token-meter'

afterEach(cleanup)

describe('TokenMeter', () => {
  it('shows detail on hover', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 30',
    })

    await user.hover(trigger)

    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(screen.getByText('input')).toBeTruthy()
    expect(screen.getByText('1,500')).toBeTruthy()
    expect(screen.getByText('200')).toBeTruthy()
    expect(screen.getByText('30')).toBeTruthy()
  })

  it('shows estimated session cost when available', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} sessionCostUsd={1.2} />)

    await user.hover(screen.getByRole('button'))

    expect(screen.getByText('cost')).toBeTruthy()
    expect(screen.getByText('$1.2000')).toBeTruthy()
  })

  it('closes after hover when the pointer leaves', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 30',
    })

    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('stays open after click until toggled off', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 30',
    })

    await user.click(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

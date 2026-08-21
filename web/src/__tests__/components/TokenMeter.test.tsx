import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TokenMeter } from '@/components/ui/token-meter'

afterEach(cleanup)

describe('TokenMeter', () => {
  it('shows detail on hover', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 2.00%',
    })

    await user.hover(trigger)

    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(screen.getByText('input')).toBeTruthy()
    expect(screen.getByText('1,500')).toBeTruthy()
    expect(screen.getByText('200')).toBeTruthy()
    expect(screen.getByText('2.00%')).toBeTruthy()
  })

  it('shows estimated session costs to four decimal places', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} sessionCostUsd={0.00135} />)

    await user.hover(screen.getByRole('button'))

    // Every other row is this agent's; the cost covers the whole team, so the
    // label has to say which scope it belongs to.
    expect(screen.getByText('session cost')).toBeTruthy()
    expect(screen.queryByText('cost')).toBeNull()
    expect(screen.getByText('$0.0014')).toBeTruthy()
  })

  it('closes after hover when the pointer leaves', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 2.00%',
    })

    await user.hover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('stays open after click until toggled off', async () => {
    const user = userEvent.setup()

    render(<TokenMeter input={1500} output={200} cached={30} cachedPercent={2} />)

    const trigger = screen.getByRole('button', {
      name: 'Input: 1,500 / 250,000 (1%) · Output: 200 · Cache: 2.00%',
    })

    await user.click(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.unhover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SessionModeToggle } from '@/components/SessionModeToggle'

afterEach(cleanup)

describe('SessionModeToggle', () => {
  test('shows the active mode and selects the other mode directly', () => {
    const onChange = mock(() => {})

    render(<SessionModeToggle mode="code" onChange={onChange} />)

    expect(screen.getByRole('button', { name: 'Code mode' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }))
    expect(onChange).toHaveBeenCalledWith('plan')
  })
})

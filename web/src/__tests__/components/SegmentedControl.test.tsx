import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SegmentedControl } from '@/components/ui/segmented-control'

afterEach(cleanup)

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
] as const

function renderControl(value: 'a' | 'b' | 'c' = 'a', onChange = mock(() => {})) {
  render(<SegmentedControl label="Letters" value={value} onChange={onChange} options={OPTIONS} />)
  return onChange
}

describe('SegmentedControl', () => {
  test('exposes a named radiogroup with the chosen segment checked', () => {
    renderControl('c')
    expect(screen.getByRole('radiogroup', { name: 'Letters' })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'Gamma' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Alpha' }).getAttribute('aria-checked')).toBe('false')
  })

  test('selects on click and ignores a click on the chosen segment', () => {
    const onChange = renderControl('a')
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('c')
  })

  test('keeps one tab stop on the chosen segment', () => {
    renderControl('c')
    expect(screen.getByRole('radio', { name: 'Gamma' }).tabIndex).toBe(0)
    expect(screen.getByRole('radio', { name: 'Alpha' }).tabIndex).toBe(-1)
  })

  test('arrow keys move and select, skipping disabled segments', () => {
    const onChange = renderControl('a')
    const alpha = screen.getByRole('radio', { name: 'Alpha' })
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('c')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Gamma' }))
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Gamma' }), { key: 'Home' })
    expect(document.activeElement).toBe(alpha)
  })

  test('disables every segment when the group is disabled', () => {
    render(<SegmentedControl label="Letters" value="a" onChange={() => {}} options={OPTIONS} disabled />)
    for (const radio of screen.getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true)
  })

  test('names icon-only segments from ariaLabel', () => {
    render(
      <SegmentedControl
        label="Theme"
        value="light"
        onChange={() => {}}
        options={[
          { value: 'light', ariaLabel: 'Light', icon: <svg /> },
          { value: 'dark', ariaLabel: 'Dark', icon: <svg /> },
        ]}
      />,
    )
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeTruthy()
  })
})

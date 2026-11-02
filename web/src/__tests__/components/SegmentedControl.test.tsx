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

  // Like a native segmented control, the fill slides from the old choice to
  // the new one instead of jumping. Before layout (no widths yet) the chosen
  // segment keeps its own fill.
  test('slides one fill under the chosen segment once the segments have widths', () => {
    const widths = new Map([['Alpha', [0, 50]], ['Beta', [50, 40]], ['Gamma', [90, 60]]])
    const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get(this: HTMLElement) { return widths.get(this.textContent ?? '')?.[0] ?? 0 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return widths.get(this.textContent ?? '')?.[1] ?? 0 } })
    try {
      const view = render(<SegmentedControl label="Letters" value="a" onChange={() => {}} options={OPTIONS} />)
      const fill = document.querySelector<HTMLElement>('[data-segment-indicator]')!
      expect(fill.style.translate).toBe('0px 0px')
      expect(fill.style.scale).toBe('50 1')
      expect(screen.getByRole('radio', { name: 'Alpha' }).className).toContain('bg-transparent')

      view.rerender(<SegmentedControl label="Letters" value="c" onChange={() => {}} options={OPTIONS} />)
      expect(fill.style.translate).toBe('90px 0px')
      expect(fill.style.scale).toBe('60 1')
      expect(fill.className).toContain('transition-[translate,scale]')
    } finally {
      if (left) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', left)
      if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
    }
  })

  test('keeps the plain fill on the chosen segment until it can measure', () => {
    renderControl('a')
    expect(screen.getByRole('radio', { name: 'Alpha' }).className).toContain('bg-(--color-fill-selected)')
    expect(screen.getByRole('radio', { name: 'Alpha' }).className).not.toContain('bg-transparent')
  })
})

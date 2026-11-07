import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

let os = 'ios'
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: true, os, isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri: true, os, isMacOverlay: false, isFullscreen: false }),
}))

const { PhoneNavBar } = await import('@/components/phone/PhoneNavBar')

afterEach(() => {
  cleanup()
  os = 'ios'
})

describe('PhoneNavBar', () => {
  it('on iOS, shows ‹ with the parent name and centres the title between equal sides', () => {
    const onBack = mock(() => {})
    render(<PhoneNavBar title="Fix the build" subtitle="openagentd" back={{ label: 'Sessions', onBack }} trailing={<button type="button">Review</button>} />)
    const back = screen.getByRole('button', { name: 'Back to Sessions' })
    expect(back.textContent).toBe('')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
    const bar = document.querySelector('[data-phone-nav-bar]') as HTMLElement
    // Equal-share sides that never shrink below their content, and a title
    // that truncates first: a long title can't run under ‹ Sessions.
    const [left, title, right] = Array.from(bar.children) as HTMLElement[]
    expect(left.className).toContain('flex-1')
    expect(right.className).toContain('flex-1')
    expect(title.className).toContain('text-center')
    expect(title.className).toContain('min-w-0')
    expect(screen.getByRole('heading', { name: 'Fix the build' }).className).toContain('font-semibold')
    expect(screen.getByText('openagentd')).toBeTruthy()
  })

  it('on Android, shows a bare ← and puts the title beside it', () => {
    os = 'android'
    render(<PhoneNavBar title="Fix the build" back={{ label: 'Sessions', onBack: () => {} }} />)
    const back = screen.getByRole('button', { name: 'Back to Sessions' })
    expect(back.textContent).toBe('')
    const bar = document.querySelector('[data-phone-nav-bar]') as HTMLElement
    expect(bar.className).toContain('flex')
    expect(bar.className).not.toContain('grid')
    expect((document.querySelector('[data-phone-nav-title]') as HTMLElement).className).not.toContain('text-center')
  })
})

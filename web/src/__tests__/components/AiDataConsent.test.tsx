import '@testing-library/jest-dom'

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'

let platform: { isTauri: boolean; os: string } = { isTauri: true, os: 'ios' }
const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({
  ...realPlatform,
  getPlatform: () => ({ isMacOverlay: false, isFullscreen: false, ...platform }),
}))
const opened: string[] = []
mock.module('@/lib/open-external', () => ({ openExternalUrl: async (url: string) => { opened.push(url) } }))

import { AI_CONSENT_KEY, AiDataConsent, PRIVACY_URL } from '@/components/AiDataConsent'

beforeEach(() => {
  localStorage.clear()
  opened.length = 0
  platform = { isTauri: true, os: 'ios' }
})

describe('AiDataConsent', () => {
  it('asks on iOS before anything is sent, and remembers the answer', () => {
    const { unmount } = render(<AiDataConsent />)
    expect(screen.getByText('Your messages go to AI providers')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Privacy policy' }))
    expect(opened).toEqual([PRIVACY_URL])
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }))
    expect(localStorage.getItem(AI_CONSENT_KEY)).toBe('agreed')
    unmount()
    render(<AiDataConsent />)
    expect(screen.queryByText('Your messages go to AI providers')).toBeNull()
  })

  it('cannot be dismissed with Escape', () => {
    render(<AiDataConsent />)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.getByText('Your messages go to AI providers')).toBeInTheDocument()
  })

  it('is not shown on desktop, Android or the web', () => {
    for (const p of [{ isTauri: true, os: 'macos' }, { isTauri: true, os: 'android' }, { isTauri: false, os: 'ios' }]) {
      platform = p
      const { unmount } = render(<AiDataConsent />)
      expect(screen.queryByText('Your messages go to AI providers')).toBeNull()
      unmount()
    }
  })
})

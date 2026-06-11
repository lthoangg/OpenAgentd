import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

mock.module('@/lib/updater', () => ({
  checkForUpdates: mock(async () => ({ status: 'up_to_date' })),
  downloadUpdate: mock(async () => ({ status: 'downloaded', version: '1.0.0' })),
  fetchReleaseNotes: mock(async () => null),
  installUpdate: mock(async () => undefined),
}))

mock.module('@/lib/open-external', () => ({
  openExternalUrl: mock(async () => undefined),
}))

mock.module('@/utils/markdown', () => ({
  MarkdownBlock: ({ content }: { content: string }) => <div>{content}</div>,
}))

import { UpdateCard } from '@/components/UpdateCard'

afterEach(() => {
  cleanup()
})

describe('UpdateCard', () => {
  it('does not throw when updater dismissal storage is unavailable', () => {
    const originalLocalStorage = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: mock(() => { throw new Error('denied') }),
        setItem: mock(() => { throw new Error('denied') }),
        removeItem: mock(() => { throw new Error('denied') }),
      },
    })

    expect(() => render(<UpdateCard />)).not.toThrow()

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    })
  })
})

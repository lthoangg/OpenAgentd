import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

type Unlisten = () => void

const listenCalls: Array<{ event: string; unlisten: Unlisten }> = []
let listenHandler = async (...args: unknown[]): Promise<Unlisten> => {
  const event = String(args[0])
  const unlisten = mock(() => {})
  listenCalls.push({ event, unlisten })
  return unlisten
}
const listenMock = mock((...args: unknown[]) => listenHandler(...args))

mock.module('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

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
  listenCalls.length = 0
  listenHandler = async (...args: unknown[]): Promise<Unlisten> => {
    const event = String(args[0])
    const unlisten = mock(() => {})
    listenCalls.push({ event, unlisten })
    return unlisten
  }
  listenMock.mockClear()
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

  it('unsubscribes updater listeners when unmounted during async setup', async () => {
    let resolveStatusListen!: (unlisten: Unlisten) => void
    const statusUnlisten = mock(() => {})
    listenHandler = async (...args: unknown[]) => {
      const event = String(args[0])
      if (event === 'updater-status') {
        listenCalls.push({ event, unlisten: statusUnlisten })
        return await new Promise<Unlisten>((resolve) => {
          resolveStatusListen = resolve
        })
      }
      const unlisten = mock(() => undefined)
      listenCalls.push({ event, unlisten })
      return unlisten
    }

    const view = render(<UpdateCard />)
    await waitFor(() => expect(resolveStatusListen).toBeDefined())
    view.unmount()
    resolveStatusListen(statusUnlisten)

    await waitFor(() => expect(statusUnlisten).toHaveBeenCalledTimes(1))
    expect(listenCalls.map((call) => call.event)).toEqual(['updater-status'])
  })
})

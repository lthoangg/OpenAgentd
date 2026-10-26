import { describe, expect, it, mock } from 'bun:test'

let isTauri = false
let os = 'macos'

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri, os, isMacOverlay: false, isFullscreen: false }),
  usePlatform: () => ({ isTauri, os, isMacOverlay: false, isFullscreen: false }),
}))

const { createQueryClient } = await import('@/lib/query-client')

describe('query client network mode', () => {
  it('keeps running while the OS reports offline in the desktop app (local backend)', () => {
    isTauri = true
    os = 'macos'
    const defaults = createQueryClient().getDefaultOptions()

    expect(defaults.queries?.networkMode).toBe('always')
    expect(defaults.mutations?.networkMode).toBe('always')
  })

  it('pauses while offline in browsers and the mobile app (remote backend)', () => {
    isTauri = false
    expect(createQueryClient().getDefaultOptions().queries?.networkMode).toBe('online')

    isTauri = true
    os = 'ios'
    const mobile = createQueryClient().getDefaultOptions()
    expect(mobile.queries?.networkMode).toBe('online')
    expect(mobile.mutations?.networkMode).toBe('online')
  })

  it('keeps the cache timings', () => {
    const queries = createQueryClient().getDefaultOptions().queries

    expect(queries?.staleTime).toBe(5 * 60 * 1000)
    expect(queries?.gcTime).toBe(10 * 60 * 1000)
    expect(queries?.refetchIntervalInBackground).toBe(false)
  })
})

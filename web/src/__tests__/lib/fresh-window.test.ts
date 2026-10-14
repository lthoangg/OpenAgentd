import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { clearFreshDesktopWindow, isFreshDesktopWindow } from '@/lib/fresh-window'

describe('fresh desktop window', () => {
  afterEach(() => {
    clearFreshDesktopWindow()
  })

  it('is false without the New Window flag', () => {
    expect(isFreshDesktopWindow()).toBe(false)
  })

  it('is true on the first load of a New Window until cleared', () => {
    window.__OAD_FRESH_WINDOW__ = true
    expect(isFreshDesktopWindow()).toBe(true)
    expect(isFreshDesktopWindow()).toBe(true)
    clearFreshDesktopWindow()
    expect(isFreshDesktopWindow()).toBe(false)
  })

  it('ignores the flag on a reload', () => {
    window.__OAD_FRESH_WINDOW__ = true
    const spy = spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' } as unknown as PerformanceEntry,
    ])
    try {
      expect(isFreshDesktopWindow()).toBe(false)
      expect(window.__OAD_FRESH_WINDOW__).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useResizableWidth } from '@/hooks/use-resizable-width'

afterEach(() => {
  cleanup()
})

describe('useResizableWidth', () => {
  it('falls back to the default width when localStorage is unavailable', () => {
    const originalLocalStorage = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('denied') },
        setItem: () => { throw new Error('denied') },
      },
    })

    const { result } = renderHook(() => useResizableWidth({
      storageKey: 'panel-width',
      defaultWidth: 320,
      minWidth: 240,
      maxWidth: 480,
      edge: 'right',
    }))

    expect(result.current.width).toBe(320)

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    })
  })
})

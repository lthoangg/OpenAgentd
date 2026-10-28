import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'

import { lazySurface, prefetchSurfaces, resetSurfacesForTest, useSurfaceMounted } from '@/lib/lazy-surface'

afterEach(() => {
  cleanup()
  resetSurfacesForTest()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

describe('lazySurface', () => {
  it('does not load its module until it renders or is prefetched', () => {
    let loads = 0
    lazySurface(() => { loads += 1; return Promise.resolve({ Hello }) }, 'Hello')
    expect(loads).toBe(0)
  })

  it('renders the module once it loads, with the fallback meanwhile', async () => {
    const module = deferred<{ Hello: typeof Hello }>()
    const Surface = lazySurface(() => module.promise, 'Hello', { fallback: <p>Loading</p> })
    render(<Surface name="Ada" />)
    expect(screen.getByText('Loading')).toBeTruthy()
    await act(async () => { module.resolve({ Hello }) })
    expect(screen.getByText('Hello Ada')).toBeTruthy()
  })

  it('renders a prefetched module on the first render, without a fallback', async () => {
    const Surface = lazySurface(() => Promise.resolve({ Hello }), 'Hello', { fallback: <p>Loading</p> })
    await prefetchSurfaces()
    render(<Surface name="Ada" />)
    expect(screen.queryByText('Loading')).toBeNull()
    expect(screen.getByText('Hello Ada')).toBeTruthy()
  })

  it('loads a module once, however often it is prefetched and rendered', async () => {
    let loads = 0
    const Surface = lazySurface(() => { loads += 1; return Promise.resolve({ Hello }) }, 'Hello')
    await Promise.all([prefetchSurfaces(), Surface.preload()])
    render(<Surface name="Ada" />)
    expect(loads).toBe(1)
  })

  it('tries again after a failed load', async () => {
    let loads = 0
    const Surface = lazySurface(() => {
      loads += 1
      return loads === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ Hello })
    }, 'Hello')
    await expect(Surface.preload()).rejects.toThrow('offline')
    await Surface.preload()
    expect(loads).toBe(2)
  })
})

describe('useSurfaceMounted', () => {
  it('mounts a surface once it is needed, and keeps it mounted', () => {
    const { result, rerender } = renderHook(({ needed }) => useSurfaceMounted(needed), { initialProps: { needed: false } })
    expect(result.current).toBe(false)
    rerender({ needed: true })
    expect(result.current).toBe(true)
    rerender({ needed: false })
    expect(result.current).toBe(true)
  })

  it('mounts every surface once the idle prefetch has run', async () => {
    lazySurface(() => Promise.resolve({ Hello }), 'Hello')
    const { result } = renderHook(() => useSurfaceMounted(false))
    expect(result.current).toBe(false)
    await act(async () => { await prefetchSurfaces() })
    expect(result.current).toBe(true)
  })
})

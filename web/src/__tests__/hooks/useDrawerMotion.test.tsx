import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useDrawerMotion } from '@/hooks/use-drawer-motion'
import { _resetDrawerMotionsForTests, getDrawerMotion } from '@/lib/drawer-motion'

function Drawer({ open, enabled = true, reduced = false }: { open: boolean; enabled?: boolean; reduced?: boolean }) {
  useDrawerMotion('d', { open, enabled, hidden: -280, reduced })
  return (
    <>
      <div data-edge-drawer-scrim="d" />
      <aside data-edge-drawer="d" />
    </>
  )
}

describe('useDrawerMotion', () => {
  let frames: Array<(now: number) => void> = []
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  const runFrames = () => {
    let at = 0
    while (frames.length && at < 5000) {
      const queued = frames
      frames = []
      at += 16
      for (const callback of queued) callback(at)
    }
  }
  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((callback: (now: number) => void) => frames.push(callback)) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => { frames = [] }) as typeof cancelAnimationFrame
  })
  afterEach(() => {
    cleanup()
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCancel
    _resetDrawerMotionsForTests()
  })

  const aside = () => document.querySelector<HTMLElement>('aside')!
  const scrim = () => document.querySelector<HTMLElement>('[data-edge-drawer-scrim]')!

  it('mounts shut off screen, with a clear scrim', () => {
    render(<Drawer open={false} />)
    expect(aside().style.translate).toBe('-280px 0')
    expect(scrim().style.opacity).toBe('0')
  })

  it('mounts open in place', () => {
    render(<Drawer open />)
    expect(aside().style.translate).toBe('')
    expect(scrim().style.opacity).toBe('1')
  })

  it('springs open and shut as the state flips', () => {
    const view = render(<Drawer open={false} />)
    view.rerender(<Drawer open />)
    expect(aside().style.translate).toBe('-280px 0') // a spring has begun, not jumped
    runFrames()
    expect(aside().style.translate).toBe('')
    view.rerender(<Drawer open={false} />)
    runFrames()
    expect(aside().style.translate).toBe('-280px 0')
    expect(scrim().style.opacity).toBe('0')
  })

  it('snaps under reduced motion', () => {
    const view = render(<Drawer open={false} reduced />)
    view.rerender(<Drawer open reduced />)
    expect(aside().style.translate).toBe('')
    expect(frames).toHaveLength(0)
  })

  it('the state change an edge swipe commits finds the spring already heading there', () => {
    const view = render(<Drawer open={false} />)
    const motion = getDrawerMotion('d')
    motion.drag(0.5)
    motion.settle(1, 3) // the release
    view.rerender(<Drawer open />) // the commit
    // One spring, uninterrupted: it was not restarted from the finger's position at rest.
    expect(frames).toHaveLength(1)
    for (const at of [0, 16]) {
      const queued = frames
      frames = []
      for (const callback of queued) callback(at)
    }
    expect(motion.progress).toBeGreaterThan(0.5 + 3 * 0.016)
  })

  it('leaves a desktop layout unstyled', () => {
    const view = render(<Drawer open={false} />)
    view.rerender(<Drawer open={false} enabled={false} />)
    expect(aside().style.translate).toBe('')
    expect(scrim().style.opacity).toBe('')
  })
})

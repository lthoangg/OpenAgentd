import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { useFakeTimers } from '../../fake-timers'

afterEach(cleanup)

function Probe({ open, seen }: { open: boolean; seen: Array<{ open: boolean; mounted: boolean; closing: boolean }> }) {
  const { mounted, closing } = useDeferredUnmount(open, 150)
  seen.push({ open, mounted, closing })
  return null
}

describe('useDeferredUnmount', () => {
  // Mounting a render later (from an effect) put a scheduler task between
  // the click and the content: a popover's own placement and its content's
  // focus then raced, and the focus could land on a still hidden field.
  it('mounts in the render that opens it', () => {
    const seen: Array<{ open: boolean; mounted: boolean; closing: boolean }> = []
    const view = render(<Probe open={false} seen={seen} />)
    seen.length = 0
    view.rerender(<Probe open seen={seen} />)
    expect(seen[0]).toEqual({ open: true, mounted: true, closing: false })
  })

  it('stays mounted, closing, until the exit has played', () => {
    const timers = useFakeTimers()
    try {
      const seen: Array<{ open: boolean; mounted: boolean; closing: boolean }> = []
      const view = render(<Probe open seen={seen} />)
      view.rerender(<Probe open={false} seen={seen} />)
      expect(seen.at(-1)).toEqual({ open: false, mounted: true, closing: true })
      act(() => timers.tick(150))
      expect(seen.at(-1)).toEqual({ open: false, mounted: false, closing: false })
    } finally {
      timers.restore()
    }
  })

  it('drops the exit at once when it opens again mid-exit', () => {
    const timers = useFakeTimers()
    try {
      const seen: Array<{ open: boolean; mounted: boolean; closing: boolean }> = []
      const view = render(<Probe open seen={seen} />)
      view.rerender(<Probe open={false} seen={seen} />)
      seen.length = 0
      view.rerender(<Probe open seen={seen} />)
      expect(seen[0]).toEqual({ open: true, mounted: true, closing: false })
      act(() => timers.tick(300))
      expect(seen.at(-1)).toEqual({ open: true, mounted: true, closing: false })
    } finally {
      timers.restore()
    }
  })
})

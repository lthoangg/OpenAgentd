/**
 * usePresenceMotion — a floating layer's enter and exit can be interrupted:
 * reopening it while it is still leaving turns it back from where it is
 * drawn, instead of restarting the enter from the hidden pose (which flashed).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { usePresenceMotion, poseFrame } from '@/components/ui/_use-presence-motion'

afterEach(cleanup)

type Call = { frames: Keyframe[]; options: KeyframeAnimationOptions }

function Layer({ closing, calls }: { closing: boolean; calls: Call[] }) {
  const ref = useRef<HTMLDivElement>(null)
  usePresenceMotion(ref, true, closing)
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el && !('recorded' in el.dataset)) {
          el.dataset.recorded = ''
          const original = el.animate.bind(el)
          el.animate = (frames, options) => {
            calls.push({ frames: frames as Keyframe[], options: options as KeyframeAnimationOptions })
            return original(frames, options)
          }
        }
      }}
    />
  )
}

describe('usePresenceMotion', () => {
  it('enters from the hidden pose the first time', () => {
    const calls: Call[] = []
    render(<Layer closing={false} calls={calls} />)
    expect(calls).toHaveLength(1)
    expect(calls[0].frames[0]).toEqual(poseFrame({ opacity: 0, scale: 0.95 }))
    expect(calls[0].frames[1]).toEqual(poseFrame({}))
  })

  it('turns a reopen mid-exit back from where it is drawn, not from hidden', () => {
    const calls: Call[] = []
    const { rerender } = render(<Layer closing={false} calls={calls} />)
    rerender(<Layer closing calls={calls} />)
    rerender(<Layer closing={false} calls={calls} />)
    expect(calls).toHaveLength(3)
    const reopen = calls[2]
    expect(reopen.frames[0]).not.toEqual(poseFrame({ opacity: 0, scale: 0.95 }))
    expect(reopen.frames[1]).toEqual(poseFrame({}))
  })

  it('holds the hidden pose after the exit until the layer unmounts', () => {
    const calls: Call[] = []
    const { rerender } = render(<Layer closing={false} calls={calls} />)
    rerender(<Layer closing calls={calls} />)
    expect(calls[1].options.fill).toBe('forwards')
    expect(calls[1].frames[1]).toEqual(poseFrame({ opacity: 0, scale: 0.95 }))
  })
})

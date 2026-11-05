import { afterEach, describe, expect, it } from 'bun:test'

import { shake } from '@/lib/shake'

const realMatchMedia = window.matchMedia
afterEach(() => {
  window.matchMedia = realMatchMedia
})

function fakeElement() {
  const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = []
  const el = {
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ keyframes, options })
      return { id: '' } as Animation
    },
    getAnimations: () => [] as Animation[],
  } as unknown as HTMLElement
  return { el, calls }
}

describe('shake', () => {
  it('wobbles translate 0, -6, 6, -4, 4, 0 over slow on ease-out', () => {
    const { el, calls } = fakeElement()
    const animation = shake(el)
    expect(animation?.id).toBe('oa-shake')
    expect(calls).toHaveLength(1)
    expect(calls[0].keyframes.map((frame) => frame.translate)).toEqual(['0px 0', '-6px 0', '6px 0', '-4px 0', '4px 0', '0px 0'])
    expect(calls[0].options.duration).toBe(400)
    expect(calls[0].options.easing).toBe('cubic-bezier(0.16, 1, 0.3, 1)')
  })

  it('does nothing under reduced motion, without an element, or without Web Animations', () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as unknown as typeof window.matchMedia
    const { el, calls } = fakeElement()
    expect(shake(el)).toBeNull()
    expect(calls).toHaveLength(0)
    window.matchMedia = realMatchMedia
    expect(shake(null)).toBeNull()
    expect(shake({} as HTMLElement)).toBeNull()
  })
})

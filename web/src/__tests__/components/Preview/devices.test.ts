import { describe, expect, it } from 'bun:test'

import { frameCaption } from '@/components/Preview/devices'

describe('frameCaption', () => {
  it('says the page size and the scale it is drawn at', () => {
    expect(frameCaption({ width: 390, height: 844 }, 0.6234)).toBe('390 × 844 · 62%')
    expect(frameCaption({ width: 1440, height: 900 }, 0.26)).toBe('1440 × 900 · 26%')
  })

  it('says only the size for a page drawn at its real size', () => {
    expect(frameCaption({ width: 390, height: 844 }, 1)).toBe('390 × 844')
    expect(frameCaption({ width: 811.6, height: 640.2 }, 1)).toBe('812 × 640')
  })
})

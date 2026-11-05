import { describe, expect, it } from 'bun:test'

import { SNAP_THRESHOLD_PX, snapToDetent } from '@/lib/resize-snap'

describe('snapToDetent', () => {
  it('lands exactly on the detent within the default 8px', () => {
    expect(SNAP_THRESHOLD_PX).toBe(8)
    expect(snapToDetent(264, 264)).toEqual({ value: 264, snapped: true })
    expect(snapToDetent(256, 264)).toEqual({ value: 264, snapped: true })
    expect(snapToDetent(272, 264)).toEqual({ value: 264, snapped: true })
    expect(snapToDetent(260.5, 264)).toEqual({ value: 264, snapped: true })
  })

  it('leaves a value beyond the threshold alone', () => {
    expect(snapToDetent(255, 264)).toEqual({ value: 255, snapped: false })
    expect(snapToDetent(273, 264)).toEqual({ value: 273, snapped: false })
    expect(snapToDetent(0, 264)).toEqual({ value: 0, snapped: false })
  })

  it('takes a threshold in the value\'s own unit (a ratio over its container)', () => {
    const threshold = 8 / 800
    expect(snapToDetent(0.505, 0.5, threshold)).toEqual({ value: 0.5, snapped: true })
    expect(snapToDetent(0.52, 0.5, threshold)).toEqual({ value: 0.52, snapped: false })
  })

  it('never snaps non-finite input or a zero threshold', () => {
    expect(snapToDetent(Number.NaN, 264).snapped).toBe(false)
    expect(snapToDetent(264, Number.NaN).snapped).toBe(false)
    expect(snapToDetent(264, 264, 0).snapped).toBe(false)
  })
})

/**
 * What the phone sheets share (``ui/_sheet``): the close distance, and the
 * detent maths of ``BottomSheet`` without a finger.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { resolveRelease, SHEET_CLOSE_DISTANCE, SHEET_CLOSE_VELOCITY, SHEET_DETENT_VH, sheetStops } from '@/components/ui/_sheet'

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../components/ui/${rel}`, import.meta.url)), 'utf8')

describe('one close threshold for the phone sheets', () => {
  it('is 120px and a 500px/s flick', () => {
    expect(SHEET_CLOSE_DISTANCE).toBe(120)
    expect(SHEET_CLOSE_VELOCITY).toBe(500)
  })

  it('is imported by both sheets, not written twice', () => {
    const overlay = source('app-overlay.tsx')
    expect(overlay).toContain("from '@/components/ui/_sheet'")
    expect(overlay).not.toMatch(/const SHEET_CLOSE_(DISTANCE|VELOCITY)\s*=/)
    // BottomSheet takes its thresholds from the same place (through resolveRelease).
    const sheet = source('bottom-sheet.tsx')
    expect(sheet).toContain("from '@/components/ui/_sheet'")
    expect(sheet).not.toMatch(/const \w*CLOSE_(?:DISTANCE|VELOCITY)\w*\s*=/)
  })
})

describe('sheetStops', () => {
  const VIEWPORT = 800
  const medium = Math.round(SHEET_DETENT_VH.medium * VIEWPORT)
  const large = Math.round(SHEET_DETENT_VH.large * VIEWPORT)

  it('puts medium at half the screen and large at 92%', () => {
    expect(SHEET_DETENT_VH).toEqual({ medium: 0.5, large: 0.92 })
    expect(sheetStops(VIEWPORT, 2000, ['medium', 'large']).map((s) => [s.name, s.px])).toEqual([['medium', medium], ['large', large]])
  })

  it('lists the stops lowest first however they are asked for', () => {
    expect(sheetStops(VIEWPORT, 2000, ['large', 'medium']).map((s) => s.name)).toEqual(['medium', 'large'])
    expect(sheetStops(VIEWPORT, 2000, ['large', 'large']).map((s) => s.name)).toEqual(['large'])
  })

  it('fits content shorter than medium: one stop, the content\'s height', () => {
    expect(sheetStops(VIEWPORT, 300, ['medium', 'large'])).toEqual([{ name: 'medium', px: 300 }])
  })

  it('caps large at the content when it falls between medium and large', () => {
    expect(sheetStops(VIEWPORT, 500, ['medium', 'large']).map((s) => s.px)).toEqual([medium, 500])
  })

  it('merges two stops closer than 24px: a sheet barely taller than medium just fits', () => {
    expect(sheetStops(VIEWPORT, medium + 10, ['medium', 'large'])).toEqual([{ name: 'medium', px: medium }])
  })

  it('leaves an unmeasured sheet to fit', () => {
    expect(sheetStops(VIEWPORT, 0, ['medium', 'large'])).toHaveLength(1)
    expect(sheetStops(VIEWPORT, 0, [])).toEqual([])
  })
})

describe('resolveRelease', () => {
  const STOPS = [400, 736]
  const at = (height: number, overshoot = 0, velocity = 0) => resolveRelease(STOPS, { height, overshoot, velocity })

  it('closes past 120px below the lowest stop, not at 120', () => {
    expect(at(400, 120)).toEqual({ kind: 'detent', index: 0 })
    expect(at(400, 121)).toEqual({ kind: 'close' })
  })

  it('settles on the nearest stop when let go slowly', () => {
    expect(at(500)).toEqual({ kind: 'detent', index: 0 })
    expect(at(600)).toEqual({ kind: 'detent', index: 1 })
  })

  it('moves one stop on a flick, and closes from the lowest on a flick down', () => {
    expect(at(700, 0, 800)).toEqual({ kind: 'detent', index: 0 })
    expect(at(400, 0, 800)).toEqual({ kind: 'close' })
    expect(at(500, 0, -800)).toEqual({ kind: 'detent', index: 1 })
    // Up from the tallest stays at it.
    expect(at(736, 0, -800)).toEqual({ kind: 'detent', index: 1 })
  })

  it('treats a flick as one of 500px/s or more, not slower', () => {
    expect(at(400, 0, SHEET_CLOSE_VELOCITY)).toEqual({ kind: 'detent', index: 0 })
    expect(at(400, 0, SHEET_CLOSE_VELOCITY + 1)).toEqual({ kind: 'close' })
  })

  it('closes a single-stop sheet on the same terms', () => {
    expect(resolveRelease([500], { height: 500, overshoot: 121, velocity: 0 })).toEqual({ kind: 'close' })
    expect(resolveRelease([500], { height: 500, overshoot: 60, velocity: 0 })).toEqual({ kind: 'detent', index: 0 })
    expect(resolveRelease([500], { height: 500, overshoot: 10, velocity: 900 })).toEqual({ kind: 'close' })
  })
})

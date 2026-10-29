import { describe, expect, it } from 'bun:test'
import { BODY_COLOURS, poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from '@/pet/sprites'
import type { PetPose } from '@/pet/state'

const POSES: PetPose[] = ['walk', 'sit', 'sleep', 'work', 'alert', 'hop', 'droop', 'look']

describe('pet sprites', () => {
  it('draws every frame of every pose on the same grid', () => {
    for (const pose of POSES) {
      for (const rows of poseFrames(pose)) {
        expect(rows).toHaveLength(SPRITE_ROWS)
        for (const row of rows) expect(row).toHaveLength(SPRITE_COLUMNS)
      }
    }
  })

  it('walks on two frames and holds still otherwise', () => {
    expect(poseFrames('walk')).toHaveLength(2)
    expect(poseFrames('sit')).toHaveLength(1)
  })

  it('closes its eyes to sleep', () => {
    const eyes = (pose: PetPose) => poseFrames(pose)[0].join('').split('E').length - 1
    expect(eyes('sit')).toBe(2)
    expect(eyes('sleep')).toBe(0)
  })

  it('paints the body in the chosen colour', () => {
    const fills = new Set(spriteRects(poseFrames('sit')[0], 'blue').map((r) => r.fill))
    expect(fills.has(BODY_COLOURS.blue)).toBe(true)
    expect(fills.has(BODY_COLOURS.orange)).toBe(false)
  })
})

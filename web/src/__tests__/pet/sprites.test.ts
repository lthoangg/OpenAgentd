import { describe, expect, it } from 'bun:test'
import { BODY_COLOURS, CHARACTERS, poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from '@/pet/sprites'
import type { PetCharacter, PetPose } from '@/pet/state'

const POSES: PetPose[] = ['walk', 'sit', 'sleep', 'work', 'alert', 'hop', 'droop', 'look']
const ALL = Object.keys(CHARACTERS) as PetCharacter[]

describe('pet sprites', () => {
  it('offers the cat, the duck and the crab', () => {
    expect(ALL).toEqual(['cat', 'duck', 'crab'])
  })

  it('draws every frame of every pose of every character on the same grid', () => {
    for (const character of ALL) {
      for (const pose of POSES) {
        for (const rows of poseFrames(character, pose)) {
          expect(rows).toHaveLength(SPRITE_ROWS)
          for (const row of rows) expect(row).toHaveLength(SPRITE_COLUMNS)
        }
      }
    }
  })

  it('walks on two different frames and holds still otherwise', () => {
    for (const character of ALL) {
      const [a, b] = poseFrames(character, 'walk')
      expect(a.join('')).not.toBe(b.join(''))
      expect(poseFrames(character, 'sit')).toHaveLength(1)
    }
  })

  it('closes its eyes to sleep', () => {
    for (const character of ALL) {
      const eyes = (pose: PetPose) => poseFrames(character, pose)[0].join('').split('E').length - 1
      expect(eyes('sit')).toBeGreaterThan(0)
      expect(eyes('sleep')).toBe(0)
    }
  })

  it('paints the body of every character in the chosen colour', () => {
    for (const character of ALL) {
      const fills = new Set(spriteRects(poseFrames(character, 'sit')[0], 'blue').map((r) => r.fill))
      expect(fills.has(BODY_COLOURS.blue)).toBe(true)
      expect(fills.has(BODY_COLOURS.orange)).toBe(false)
    }
  })
})

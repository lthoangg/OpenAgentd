import { describe, expect, it } from 'bun:test'
import { BALLOON_COLUMNS, BALLOON_ROWS, BODY_COLOURS, CHARACTERS, balloonRows, poseFrames, spriteRects, SPRITE_COLUMNS, SPRITE_ROWS } from '@/pet/sprites'
import type { PetCharacter, PetPose } from '@/pet/state'

const POSES: PetPose[] = ['walk', 'sit', 'sleep', 'work', 'alert', 'hop', 'droop', 'look', 'climb', 'float', 'fall']
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

  it('climbs on the walking frames and floats or falls on the standing one', () => {
    for (const character of ALL) {
      expect(poseFrames(character, 'climb')).toEqual(poseFrames(character, 'walk'))
      expect(poseFrames(character, 'float')).toEqual(poseFrames(character, 'sit'))
      expect(poseFrames(character, 'fall')).toEqual(poseFrames(character, 'sit'))
    }
  })

  it('draws the balloon whole and popped on one grid, in red whatever the pet colour', () => {
    for (const popped of [false, true]) {
      const rows = balloonRows(popped)
      expect(rows).toHaveLength(BALLOON_ROWS)
      for (const row of rows) expect(row).toHaveLength(BALLOON_COLUMNS)
    }
    expect(balloonRows(false).join('')).not.toBe(balloonRows(true).join(''))
    const fills = (colour: 'orange' | 'blue') => spriteRects(balloonRows(false), colour).map((r) => r.fill)
    expect(fills('orange')).toEqual(fills('blue'))
    expect(new Set(fills('blue')).size).toBeGreaterThan(2)
  })
})

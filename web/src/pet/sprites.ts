/**
 * The cat, as pixel rows (16 × 12). Each frame is drawn as crisp SVG
 * rects, so it scales to any size without blurring.
 *
 *   O outline · B body · E eye · P cheek · . transparent
 */
import type { PetColour, PetPose } from './state'

const HEAD = [
  '..........O...O.',
  '.........OBO.OBO',
  '.........OBBOBBO',
  'O........OBBBBBO',
  'OB.......OBEBBEO',
  '.OB......OBBPBBO',
  '.OB.OOOOOOBBBBO.',
  '..OBBBBBBBBBBBO.',
  '..OBBBBBBBBBBO..',
  '..OOOOOOOOOOOO..',
]

const LEGS_A = ['..OB.OB...OB.OB.', '..OO.OO...OO.OO.']
const LEGS_B = ['...OB.OB.OB.OB..', '...OO.OO.OO.OO..']
const LEGS_SIT = ['..OBBOO...OBBOO.', '..OOOO....OOOO..']

/** Eyes shut: the eye row with outline-coloured lids instead of pupils. */
function sleepy(rows: string[]): string[] {
  return rows.map((row, i) => (i === 4 ? row.replace(/E/g, 'O') : row))
}

/** The pixel art is a fixed palette, like the app icon: not theme colours. */
export const BODY_COLOURS: Record<PetColour, string> = {
  orange: '#F59E3B',
  paper: '#F5EBD8',
  bark: '#8A7258',
  blue: '#5AA8E2',
}

const OUTLINE = '#1A1714'
const CHEEK = '#E58A9A'

/** The frames a pose cycles through (one frame holds still). */
export function poseFrames(pose: PetPose): string[][] {
  switch (pose) {
    case 'walk':
      return [[...HEAD, ...LEGS_A], [...HEAD, ...LEGS_B]]
    case 'sleep':
      return [sleepy([...HEAD, ...LEGS_SIT])]
    default:
      return [[...HEAD, ...LEGS_SIT]]
  }
}

export interface SpriteRect {
  x: number
  y: number
  fill: string
}

/** The filled pixels of one frame. */
export function spriteRects(rows: string[], colour: PetColour): SpriteRect[] {
  const fills: Record<string, string> = { O: OUTLINE, E: OUTLINE, B: BODY_COLOURS[colour], P: CHEEK }
  const rects: SpriteRect[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const fill = fills[row.charAt(x)]
      if (fill) rects.push({ x, y, fill })
    }
  })
  return rects
}

export const SPRITE_COLUMNS = 16
export const SPRITE_ROWS = 12

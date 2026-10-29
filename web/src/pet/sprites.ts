/**
 * The characters, as pixel rows (16 × 12). Each frame is drawn as crisp SVG
 * rects, so it scales to any size without blurring.
 *
 *   O outline · B body · E eye · P cheek · K beak and feet · . transparent
 */
import type { PetCharacter, PetColour, PetPose } from './state'

const CAT_HEAD = [
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

const CAT_LEGS_A = ['..OB.OB...OB.OB.', '..OO.OO...OO.OO.']
const CAT_LEGS_B = ['...OB.OB.OB.OB..', '...OO.OO.OO.OO..']
const CAT_LEGS_SIT = ['..OBBOO...OBBOO.', '..OOOO....OOOO..']

const DUCK_BODY = [
  '........OOOO....',
  '.......OBBBBO...',
  '.......OBBEBKKK.',
  '.......OBBBBKKO.',
  '.O.....OBBBBOO..',
  '.OBO..OBBBBBO...',
  '.OBBOOBBBBBBBO..',
  '.OBBBBBBBBBBBO..',
  '..OBBBBOOBBBBO..',
  '..OBBBBBBBBBO...',
  '...OOOOOOOOO....',
]

const CRAB_BODY = [
  '.OO..........OO.',
  'OBBO........OBBO',
  'OB.O........O.BO',
  '.OBO.O....O.OBO.',
  '..OBOEO..OEOBO..',
  '...OBBOOOOBBO...',
  '..OBBBBBBBBBBO..',
  '.OBBBBBBBBBBBBO.',
  '.OBBBBBBBBBBBBO.',
  '..OBBBBBBBBBBO..',
]
const CRAB_LEGS_A = ['..O.O.OOOO.O.O..', '.O.O........O.O.']
const CRAB_LEGS_B = ['.O.O..OOOO..O.O.', '..O.O......O.O..']

interface CharacterArt {
  /** Standing or sitting still. */
  still: string[]
  /** The two frames that take turns while it walks. */
  walk: [string[], string[]]
}

/** Every character the pet can be, in the order Settings lists them. */
export const CHARACTERS: Record<PetCharacter, CharacterArt> = {
  cat: {
    still: [...CAT_HEAD, ...CAT_LEGS_SIT],
    walk: [[...CAT_HEAD, ...CAT_LEGS_A], [...CAT_HEAD, ...CAT_LEGS_B]],
  },
  duck: {
    still: [...DUCK_BODY, '.....KK..KK.....'],
    walk: [[...DUCK_BODY, '....KK....KK....'], [...DUCK_BODY, '......KKKK......']],
  },
  crab: {
    still: [...CRAB_BODY, ...CRAB_LEGS_A],
    walk: [[...CRAB_BODY, ...CRAB_LEGS_A], [...CRAB_BODY, ...CRAB_LEGS_B]],
  },
}

/** Eyes shut: outline-coloured lids instead of pupils. */
function sleepy(rows: string[]): string[] {
  return rows.map((row) => row.replace(/E/g, 'O'))
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
const BEAK = '#F28C28'

/** The frames a pose cycles through (one frame holds still). */
export function poseFrames(character: PetCharacter, pose: PetPose): string[][] {
  const art = CHARACTERS[character] ?? CHARACTERS.cat
  switch (pose) {
    case 'walk':
    case 'zoom':
      return [...art.walk]
    case 'sleep':
      return [sleepy(art.still)]
    default:
      return [art.still]
  }
}

export interface SpriteRect {
  x: number
  y: number
  fill: string
}

/** The filled pixels of one frame. */
export function spriteRects(rows: string[], colour: PetColour): SpriteRect[] {
  const fills: Record<string, string> = { O: OUTLINE, E: OUTLINE, B: BODY_COLOURS[colour], P: CHEEK, K: BEAK }
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

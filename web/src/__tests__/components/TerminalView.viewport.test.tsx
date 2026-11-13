import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../../components/Terminal/TerminalView.tsx', import.meta.url)),
  'utf8',
)

describe('TerminalView mobile viewport fitting', () => {
  it('refits the terminal when the visual viewport changes for the soft keyboard', () => {
    expect(source).toContain("visualViewport?.addEventListener('resize', refit)")
    expect(source).toContain("visualViewport?.removeEventListener('resize', refit)")
  })
})

describe('TerminalView long-press menu', () => {
  it('is keyed on touch, not on window size, so a wide tablet has it too', () => {
    expect(source).toContain('const touchFirst = useTouchFirst()')
    expect(source).toContain('useLongPressSurface(isMobile || touchFirst, ')
  })
})

export {}

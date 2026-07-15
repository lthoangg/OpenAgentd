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

export {}

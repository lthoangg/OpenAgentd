import { describe, expect, it } from 'bun:test'

import { terminalBufferText, type TextBuffer } from '@/components/Terminal/terminal-text'

/** A buffer of fixed-width rows; ``wrapped`` marks rows that continue the one above. */
function buffer(rows: string[], options: { cols?: number; wrapped?: number[]; viewportY?: number } = {}): TextBuffer {
  const cols = options.cols ?? 10
  const wrapped = new Set(options.wrapped ?? [])
  return {
    length: rows.length,
    viewportY: options.viewportY ?? 0,
    getLine: (y) => {
      const row = rows[y]
      if (row === undefined) return undefined
      const padded = row.padEnd(cols, ' ')
      return {
        isWrapped: wrapped.has(y),
        translateToString: (trimRight?: boolean) => (trimRight ? padded.replace(/\s+$/, '') : padded),
      }
    },
  }
}

describe('terminalBufferText', () => {
  it('joins a wrapped row onto the line above it, keeping the space at the wrap column', () => {
    const { lines } = terminalBufferText(buffer(['echo one ', 'two three', '$'], { cols: 9, wrapped: [1] }))
    expect(lines).toEqual(['echo one two three', '$'])
  })

  it('drops trailing spaces and trailing blank rows', () => {
    const { lines } = terminalBufferText(buffer(['a  ', '', 'b', '', '']))
    expect(lines).toEqual(['a', '', 'b'])
  })

  it('points at the line that holds the first row on screen', () => {
    const rows = ['l0', 'l1-long-row', 'cont', 'l2', 'l3']
    expect(terminalBufferText(buffer(rows, { wrapped: [2], viewportY: 3 })).viewportLine).toBe(2)
    // A wrapped row on screen belongs to the line it continues.
    expect(terminalBufferText(buffer(rows, { wrapped: [2], viewportY: 2 })).viewportLine).toBe(1)
  })

  it('keeps the viewport line inside the text when the screen is blank below it', () => {
    const { lines, viewportLine } = terminalBufferText(buffer(['a', '', ''], { viewportY: 2 }))
    expect(lines).toEqual(['a'])
    expect(viewportLine).toBe(0)
  })
})

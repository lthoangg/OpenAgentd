import { describe, expect, it } from 'bun:test'
import { parseSearchResult } from '@/utils/search-result'

describe('parseSearchResult', () => {
  it('reads plain matches', () => {
    const parsed = parseSearchResult('src/a.ts:3: const a = 1\nsrc/b.ts:9: const b = 2')
    expect(parsed).toEqual({
      lines: [
        { kind: 'match', text: 'src/a.ts:3: const a = 1' },
        { kind: 'match', text: 'src/b.ts:9: const b = 2' },
      ],
      matches: 2,
      note: null,
    })
  })

  it('tells context lines and group breaks from matches', () => {
    const parsed = parseSearchResult(
      ['src/a.ts-2- // before', 'src/a.ts:3: const a = 1', 'src/a.ts-4- // after', '--', 'src/b.ts:9: const b = 2'].join('\n'),
    )
    expect(parsed?.lines.map((line) => line.kind)).toEqual(['context', 'match', 'context', 'gap', 'match'])
    expect(parsed?.matches).toBe(2)
  })

  it('takes the note about left-out matches off the list', () => {
    const parsed = parseSearchResult(
      'src/a.ts:3: hit\n\n[1 of 40 matching lines shown. The other 39 are in src/b.ts. Narrow the pattern, directory or include, or raise max_results.]',
    )
    expect(parsed?.lines).toEqual([{ kind: 'match', text: 'src/a.ts:3: hit' }])
    expect(parsed?.note).toBe(
      '1 of 40 matching lines shown. The other 39 are in src/b.ts. Narrow the pattern, directory or include, or raise max_results.',
    )
  })

  it('goes by the first line number in a line, so code that looks like one is not misread', () => {
    const parsed = parseSearchResult(
      ['src/a.ts:3: at b.ts-12- something', 'src/a.ts-4- see c.ts:7: there', 'lib/step-12-done.ts:5: x'].join('\n'),
    )
    expect(parsed?.lines.map((line) => line.kind)).toEqual(['match', 'context', 'match'])
  })

  it('is null when no line is a match, so a list of paths or "No matches" is not a search result', () => {
    expect(parseSearchResult('src/foo.ts\nsrc/bar.ts')).toBeNull()
    expect(parseSearchResult("No matches for pattern 'x' in . (include=*)")).toBeNull()
    expect(parseSearchResult('')).toBeNull()
  })
})

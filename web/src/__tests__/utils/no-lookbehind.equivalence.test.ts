/**
 * The lookbehind-free patterns in markdown-math, inline-markdown and
 * file-refs must match exactly what the lookbehind originals matched. Fuzzed
 * over strings built from the characters those boundaries care about.
 */
import { describe, expect, it } from 'bun:test'
import { findFileRefs } from '@/utils/file-refs'
import { findInlineMarkers } from '@/utils/inline-markdown'

// Seeded LCG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

function corpus(alphabet: string[], count: number, maxLen: number, seed: number): string[] {
  const next = rng(seed)
  return Array.from({ length: count }, () => {
    const len = Math.floor(next() * maxLen)
    let s = ''
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)]
    return s
  })
}

type Hit = [number, number, ...(string | undefined)[]]

function hits(re: RegExp, text: string, normalize: (m: RegExpExecArray) => Hit): Hit[] {
  re.lastIndex = 0
  const out: Hit[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(normalize(m))
    if (m[0] === '') re.lastIndex++
  }
  return out
}

describe('lookbehind-free patterns', () => {
  it('inline math matches like the lookbehind original', () => {
    const OLD = /(?:\\\$)|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\\\(([\s\S]+?)\\\))|(?:\$(?!\s)([^$\n]+?)(?<![\s\\])\$)/g
    const NEW = /(?:\\\$)|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\\\(([\s\S]+?)\\\))|(?:\$(?!\s)([^$\n]*?[^\s\\$])\$)/g
    const plain = (m: RegExpExecArray): Hit => [m.index, m[0].length, m[1], m[2], m[3], m[4]]
    for (const text of corpus(['$', '$', '\\', ' ', 'x', 'y', '\n', '(', ')', '[', ']', '5'], 20000, 16, 1)) {
      expect(hits(NEW, text, plain)).toEqual(hits(OLD, text, plain))
    }
  })

  it('inline markdown tokens match like the lookbehind original', () => {
    const OLD = /`([^`\n]+)`|\$(?!\s)([^$\n]+?)(?<![\s\\])\$|\*\*(\S(?:[^*\n]*\S)?)\*\*|\*(\S(?:[^*\n]*\S)?)\*|(?<![A-Za-z0-9])_(\S(?:[^_\n]*\S)?)_(?![A-Za-z0-9])/g
    const hit = (m: RegExpExecArray): Hit => [m.index, m[0].length, m[1], m[2], m[3], m[4], m[5]]
    for (const text of corpus(['_', '_', '*', '`', '$', ' ', 'a', '1', '-', '\\', '\n'], 20000, 16, 2)) {
      expect(findInlineMarkers(text).map(hit)).toEqual(hits(OLD, text, hit))
    }
  })

  it('free-text file references match like the lookbehind original', () => {
    const SEGMENT = String.raw`[\w@+-](?:[\w.@+-]*[\w@+-])?`
    const PATH = String.raw`(?:\.{1,2}\/|~\/|\/)?(?:\.?${SEGMENT}\/)*${SEGMENT}`
    const POSITION = String.raw`(?::(\d+)(?::(\d+))?(?:[-–](\d+))?|#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?)`
    const OLD = new RegExp(String.raw`(?<![\w./@~:-])(${PATH})${POSITION}?(?![\w/])`, 'g')
    const hasExt = (path: string) => /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path.slice(path.lastIndexOf('/') + 1))
    // The reference implementation: findFileRefs' filters on the old matches.
    const expected = (text: string) =>
      hits(OLD, text, (m) => [m.index, m[0].length, m[1], m[2] ?? m[5]])
        .filter(([, , path, line]) => path !== undefined && hasExt(path) && (path.includes('/') || line !== undefined) && (line === undefined || Number(line) >= 1))
        .map(([start, len, path]) => ({ start, end: start + len, path }))
    const alphabet = ['a', 'b', '/', '/', '.', 'ts', '.ts', ':', '1', '0', ' ', '-', '+', '@', '~', '#L', 'C', '_', ',', '(']
    for (const text of corpus(alphabet, 20000, 14, 3)) {
      const got = findFileRefs(text).map(({ start, end, ref }) => ({ start, end, path: ref.path }))
      expect(got).toEqual(expected(text))
    }
  })
})

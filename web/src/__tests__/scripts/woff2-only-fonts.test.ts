import { expect, it } from 'bun:test'
import { keepWoff2Sources } from '../../../scripts/woff2-only-fonts'

it('drops woff and truetype fallbacks when a woff2 source exists', () => {
  const css = '@font-face{font-family:KaTeX_AMS;src:url(fonts/A.woff2) format("woff2"),url(fonts/A.woff) format("woff"),url(fonts/A.ttf) format("truetype")}'
  expect(keepWoff2Sources(css)).toBe('@font-face{font-family:KaTeX_AMS;src:url(fonts/A.woff2) format("woff2")}')
})

it('handles several faces and spaced declarations', () => {
  const css = [
    '@font-face {\n  font-family: A;\n  src: url("a.woff2") format(\'woff2\'),\n    url("a.ttf") format(\'truetype\');\n  font-weight: 400;\n}',
    '@font-face{font-family:B;src:url(b.woff2) format("woff2"),url(b.woff) format("woff")}',
  ].join('\n')
  const out = keepWoff2Sources(css)
  expect(out).toContain('src: url("a.woff2") format(\'woff2\');\n  font-weight: 400;')
  expect(out).toContain('src:url(b.woff2) format("woff2")}')
  expect(out).not.toMatch(/\.ttf|b\.woff\)/)
})

it('leaves faces without a woff2 source and non-font rules untouched', () => {
  const css = '@font-face{font-family:C;src:url(c.woff) format("woff"),url(c.ttf) format("truetype")}.x{src:url(a,b)}'
  expect(keepWoff2Sources(css)).toBe(css)
})

it('does not split on commas inside url()', () => {
  const css = '@font-face{font-family:D;src:url("data:font/woff2;base64,AA,BB") format("woff2"),url(d.ttf) format("truetype")}'
  expect(keepWoff2Sources(css)).toBe('@font-face{font-family:D;src:url("data:font/woff2;base64,AA,BB") format("woff2")}')
})

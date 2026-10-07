import type { Plugin } from 'vite'

/**
 * Every webview the app ships in (WKWebView, WebView2, WebKitGTK) and every
 * supported browser picks a `woff2` source first, so `woff`/`truetype`
 * fallbacks listed after it are never fetched. Vite still emits each `url()`
 * as an asset, which put ~880 kB of unused KaTeX fonts into every desktop and
 * mobile bundle. This keeps only the `woff2` sources of any `@font-face`
 * that has one; faces without a `woff2` source are left alone.
 */
export function keepWoff2Sources(css: string): string {
  let out = ''
  let cursor = 0
  const faces = /@font-face\s*\{/g
  for (let face = faces.exec(css); face; face = faces.exec(css)) {
    const bodyStart = face.index + face[0].length
    const bodyEnd = scanUntil(css, bodyStart, '}')
    const src = /\bsrc\s*:\s*/g
    src.lastIndex = bodyStart
    const declaration = src.exec(css)
    if (declaration && declaration.index < bodyEnd) {
      const listStart = declaration.index + declaration[0].length
      const listEnd = scanUntil(css, listStart, ';}')
      const list = css.slice(listStart, listEnd)
      const sources = splitTopLevel(list)
      const woff2 = sources.filter((source) => /format\(\s*["']?woff2["']?\s*\)/.test(source))
      if (woff2.length > 0 && woff2.length < sources.length) {
        // Keep whatever whitespace followed the original list (before `;`/`}`).
        const trailing = /\s*$/.exec(list)?.[0] ?? ''
        out += css.slice(cursor, listStart) + woff2.map((source) => source.trim()).join(',') + trailing
        cursor = listEnd
      }
    }
    faces.lastIndex = bodyEnd
  }
  return out + css.slice(cursor)
}

/** Index of the first of `stops` at or after `from` that sits outside
 *  parentheses and quotes (so `;` or `,` inside a data URI never count),
 *  or the end of `text`. */
function scanUntil(text: string, from: number, stops: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && stops.includes(ch)) {
      return i
    }
  }
  return text.length
}

/** Split a declaration value on commas outside parentheses and quotes. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let start = 0
  while (start <= value.length) {
    const end = scanUntil(value, start, ',')
    parts.push(value.slice(start, end))
    start = end + 1
  }
  return parts
}

/** Vite plugin applying {@link keepWoff2Sources} to plain CSS modules
 *  before Vite resolves their `url()`s, so dropped fonts are never emitted. */
export function woff2OnlyFonts(): Plugin {
  return {
    name: 'openagentd:woff2-only-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('?') || !id.endsWith('.css') || !code.includes('@font-face')) return null
      const next = keepWoff2Sources(code)
      return next === code ? null : { code: next, map: null }
    },
  }
}

/**
 * Borderless-controls guard (DESIGN.md → "Fewer borders, one frame at most").
 *
 * Controls carry no border of their own: a primary button is filled with Bark,
 * a secondary one with the keycap wash (`bg-key`), a ghost one is text only, a
 * chip is a soft fill. Borders are left for text inputs (and field-like
 * pickers) and the one thin frame around a container (card, menu, popover,
 * dialog). Nothing inside a container adds another.
 *
 * This scans app source for interactive elements whose classes draw a border
 * (`border`, `border-2`, or a variant such as `hover:border`):
 *
 *   - opening tags of buttons, links, labels, summaries and anything named
 *     `*Button`, `*Trigger` or `*Link`;
 *   - `div`/`span`/`li` with `role="button|tab|option|menuitem|radio|checkbox|switch"`;
 *   - class-string constants (`const X = '…hover:…'`) that carry a border.
 *
 * ``ALLOW`` is an exact per-file count of the legitimate exceptions. The counts
 * are exact, not maxima, so converting an offender means deleting its entry;
 * the list only shrinks. A new bordered control fails with the file, the line
 * and the rule.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const RULE =
  'controls are borderless (DESIGN.md → Fewer borders): fill a primary with bg-(--color-accent), a secondary with bg-(--bg-key), keep a ghost text only, make a chip a soft fill (ui/button, ui/chip); a floating control over content keeps bg-(--bg-card) + shadow-(--shadow-depth). Borders stay on text inputs and the one frame around a container'

const ALLOW: Record<string, number> = {
  // Text fields and field-like pickers: a border says "this takes input".
  'components/NewSession/WorkspacePicker.tsx': 1,
  'components/ui/date-time-picker.tsx': 1,
  // Attachment cards are containers, one frame each (the × on a card is borderless).
  'components/FileCard.tsx': 1,
  'components/FilePreviewStrip.tsx': 3,
  'components/DesignFeedbackViews.tsx': 1,
  // A standalone card in a grid of cards (each its own frame, no list around them).
  'components/settings/pages/settings.index.tsx': 1,
  // Design-board preview of the form primitives, not product UI.
  'components/previews/FormPrimitivesPreview.tsx': 1,
}

// ── Scanner ──────────────────────────────────────────────────────────────────

interface Hit {
  line: number
  kind: string
  start: number
  end: number
}

/** Index of the quote that closes the string opened at ``i`` (template `${}` aware). */
function skipString(src: string, i: number): number {
  const quote = src[i]
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') j++
    else if (c === quote) return j
    else if (quote === '`' && c === '$' && src[j + 1] === '{') j = skipTemplateExpression(src, j + 1)
  }
  return src.length - 1
}

/** Index of the `}` that closes the `${` whose brace is at ``open``. */
function skipTemplateExpression(src: string, open: number): number {
  let depth = 0
  for (let j = open; j < src.length; j++) {
    const c = src[j]
    if (c === '"' || c === "'" || c === '`') j = skipString(src, j)
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j
  }
  return src.length - 1
}

/**
 * The JSX opening tag that starts at ``start``, with comments inside its
 * braces removed (an apostrophe in a `// row's width` comment must not open a
 * string), and the index just past it.
 */
function readOpeningTag(src: string, start: number): { text: string; end: number } {
  let depth = 0
  let text = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const close = skipString(src, i)
      text += src.slice(i, close + 1)
      i = close
    } else if (depth > 0 && c === '/' && src[i + 1] === '/') {
      const newline = src.indexOf('\n', i)
      i = newline === -1 ? src.length : newline - 1
    } else if (depth > 0 && c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 1
    } else {
      if (c === '{') depth++
      else if (c === '}') depth--
      text += c
      if (c === '>' && depth === 0) return { text, end: i + 1 }
    }
  }
  return { text, end: src.length }
}

/** A border width on any variant: `border`, `border-2`, `hover:border`. Not `border-0`, `border-t`, `border-(--x)`, `border-transparent`. */
const BORDER_TOKEN = /^(?:[^\s:]+:)*border(?:-[1-9]\d*)?$/

function drawsBorder(text: string): boolean {
  return text.split(/[\s"'`{}]+/).some((token) => BORDER_TOKEN.test(token))
}

const CONTROL_TAG = /<(button|a|summary|label|Link|Button|[A-Z]\w*(?:Button|Trigger|Link))\b/g
const ROLE_TAG = /<(div|span|li)\b/g
const ROLE = /role="(?:button|tab|option|menuitem|radio|checkbox|switch)"/
const CLASS_CONSTANT = /(?:const|let)\s+[\w$]+\s*(?::\s*string\s*)?=\s*(['"`])([^'"`]*)\1/g
/** Comment lines describe classes without applying them. */
const COMMENT_LINE = /^(?:\*|\/\/|\/\*|\{\/\*)/

/** Interactive elements in ``src`` that draw a border, one per element, in source order. */
function scanSource(src: string): Hit[] {
  const lineAt = (index: number) => src.slice(0, index).split('\n').length
  const lines = src.split('\n')
  const inComment = (index: number) => COMMENT_LINE.test(lines[lineAt(index) - 1].trim())
  const hits: Hit[] = []

  for (const m of src.matchAll(CONTROL_TAG)) {
    if (inComment(m.index)) continue
    const tag = readOpeningTag(src, m.index)
    if (drawsBorder(tag.text)) hits.push({ line: lineAt(m.index), kind: m[1], start: m.index, end: tag.end })
  }
  for (const m of src.matchAll(ROLE_TAG)) {
    if (inComment(m.index)) continue
    const tag = readOpeningTag(src, m.index)
    if (ROLE.test(tag.text) && drawsBorder(tag.text)) {
      hits.push({ line: lineAt(m.index), kind: `${m[1]}[role]`, start: m.index, end: tag.end })
    }
  }
  for (const m of src.matchAll(CLASS_CONSTANT)) {
    const classes = m[2]
    if (classes.includes('hover:') && drawsBorder(classes)) {
      hits.push({ line: lineAt(m.index), kind: 'class constant', start: m.index, end: m.index + m[0].length })
    }
  }

  // A trigger whose render prop holds the bordered button is one element, not
  // two: keep the innermost, which names the right line.
  return hits
    .filter((hit) => !hits.some((other) => other !== hit && other.start > hit.start && other.start < hit.end))
    .sort((a, b) => a.start - b.start)
}

function scanTree(): Map<string, Hit[]> {
  const found = new Map<string, Hit[]>()
  for (const file of sourceFiles(SRC)) {
    const hits = scanSource(readFileSync(file, 'utf8'))
    if (hits.length) found.set(relative(SRC, file), hits)
  }
  return found
}

describe('borderless controls', () => {
  it('draws no border on a control outside the allowlist', () => {
    const found = scanTree()
    const failures: string[] = []
    for (const [file, hits] of found) {
      const allowed = ALLOW[file] ?? 0
      if (hits.length === allowed) continue
      if (hits.length < allowed) {
        failures.push(`${file}: ALLOW says ${allowed} bordered control(s) but ${hits.length} remain; update the entry (the list only shrinks)`)
        continue
      }
      const note = allowed ? ` (${allowed} allowed, ${hits.length} found)` : ''
      for (const hit of hits) failures.push(`${file}:${hit.line} <${hit.kind}> draws a border${note}; ${RULE}`)
    }
    for (const [file, allowed] of Object.entries(ALLOW)) {
      if (!found.has(file)) failures.push(`${file}: ALLOW says ${allowed} bordered control(s) but none remain; delete the entry`)
    }
    expect(failures).toEqual([])
  })

  it('flags buttons, links, triggers, roles and hover constants that draw a border', () => {
    expect(scanSource('<button className="rounded-sm border px-2">x</button>').map((h) => h.kind)).toEqual(['button'])
    expect(scanSource('<Link to="/" className="rounded-sm border-2 px-2">x</Link>').map((h) => h.kind)).toEqual(['Link'])
    expect(scanSource('<button className={cn(on ? "bg-(--bg-key)" : "hover:border")}>x</button>')).toHaveLength(1)
    expect(scanSource('<div role="tab" className="border px-2">x</div>').map((h) => h.kind)).toEqual(['div[role]'])
    expect(scanSource("const ACTION = 'rounded-sm border px-2 hover:bg-(--bg-key)'").map((h) => h.kind)).toEqual(['class constant'])
  })

  it('ignores borderless controls, colour-only tokens, one-sided borders and plain containers', () => {
    expect(scanSource('<button className="rounded-sm bg-(--bg-key) px-2 hover:bg-(--color-fill-key-hover)">x</button>')).toEqual([])
    expect(scanSource('<button className="rounded-sm border-(--color-border) px-2 hover:border-transparent">x</button>')).toEqual([])
    expect(scanSource('<button className="border-t px-2">x</button>')).toEqual([])
    expect(scanSource('<Button variant="ghost" className="border-0 px-2">x</Button>')).toEqual([])
    expect(scanSource('<div className="rounded-sm border border-(--color-border-subtle)">x</div>')).toEqual([])
    expect(scanSource('<div role="presentation" className="border">x</div>')).toEqual([])
    expect(scanSource("const CARD = 'rounded-sm border px-2'")).toEqual([])
    expect(scanSource('// <button className="border">\n<button className="px-2">x</button>')).toEqual([])
  })

  it('does not read a comment inside the tag as classes', () => {
    const src = [
      '<button',
      '  className={cn(',
      "    // The row's width stays whole; a border here would be a frame.",
      "    'flex w-full px-4',",
      '  )}',
      '>',
      '  <span className="border border-(--color-border)">tile</span>',
      '</button>',
    ].join('\n')
    expect(scanSource(src)).toEqual([])
  })

  it('names the element in a trigger whose render prop holds the bordered button, once, at its own line', () => {
    const src = [
      '<TooltipTrigger',
      '  render={',
      '    <button type="button" className="rounded-sm border px-2">',
      '      x',
      '    </button>',
      '  }',
      '/>',
    ].join('\n')
    expect(scanSource(src).map((h) => [h.kind, h.line])).toEqual([['button', 3]])
  })
})

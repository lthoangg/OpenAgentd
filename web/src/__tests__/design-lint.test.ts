/**
 * Design-system guard (DESIGN.md). Scans app source for class patterns that
 * drift from the tokens: sub-floor type, un-tokenized radius, ad hoc shadows,
 * raw black/white, hard-coded scrims, legacy arbitrary-var syntax, and so on.
 *
 * ``allow`` is an exact per-file count. Legitimate exceptions (rendered
 * content such as a PDF page or a web preview, the floating composer) stay
 * listed; everything else should be zero. The counts are exact, not maxima,
 * so fixing an offender means deleting its entry — the list only shrinks.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

interface Rule {
  name: string
  why: string
  pattern: RegExp
  allow: Record<string, number>
}

const RULES: Rule[] = [
  {
    name: 'sub-floor-text',
    why: 'index.css clamps 8–10.5px to 11px; write text-[11px] so the class matches the result',
    pattern: /(?<![\w-])(?:md:)?text-\[(?:8|9|10|10\.5)px\]/g,
    allow: {},
  },
  {
    name: 'bare-rounded',
    why: 'bare `rounded` is Tailwind\'s un-themed radius; use rounded-xs/sm/md',
    pattern: /(?<![\w:-])rounded(?![\w-])/g,
    allow: {},
  },
  {
    name: 'pure-white-black',
    why: 'every neutral is warm; raw white/black only where real content renders',
    pattern: /(?<![\w-])(?:bg|text|border|ring)-(?:white|black)(?![\w/-])/g,
    allow: {
      // Rendered content: image/video letterbox, PDF page, web preview.
      'utils/markdown.tsx': 1,
      'components/PdfDocumentViewer.tsx': 1,
      'components/FileViewerPanel.tsx': 1,
      'components/Preview/PreviewTabView.tsx': 2,
    },
  },
  {
    name: 'black-scrim',
    why: 'modal and drawer scrims use bg-(--color-overlay)',
    pattern: /(?<![\w-])bg-black\/\d+/g,
    allow: {
      // Media lightbox: content wants a near-black stage.
      'components/FileLightbox.tsx': 1,
    },
  },
  {
    name: 'adhoc-shadow',
    why: 'depth is tonal; floating layers use shadow-(--shadow-depth)',
    pattern: /(?<![\w-])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl)|-\[[^\]]*\])?(?![\w-])/g,
    allow: {
      // App icon artwork on the boot / error screens.
      'App.tsx': 1,
      'routes/__root.tsx': 1,
      // Rendered content: PDF page and sized web-preview viewport.
      'components/PdfDocumentViewer.tsx': 1,
      'components/Preview/PreviewTabView.tsx': 1,
      // The composer floats over the transcript (rest and minimized states).
      'components/InputComposer.tsx': 2,
      // Design-board preview card, not product UI.
      'components/previews/FormPrimitivesPreview.tsx': 1,
    },
  },
  {
    name: 'legacy-var-syntax',
    why: 'use the Tailwind v4 shorthand `(--token)` instead of `[var(--token)]`',
    pattern: /\[var\(--/g,
    allow: {},
  },
  {
    name: 'invalid-fraction',
    why: 'spacing only accepts quarter steps; anything else generates no CSS',
    pattern: /(?<![\w-])-?(?:p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|[hw]|min-[hw]|max-[hw]|size|top|left|right|bottom|inset(?:-[xy])?|space-[xy])-\d+\.[1-46-9](?![\w.])/g,
    allow: {},
  },
  {
    name: 'accent-focus-ring',
    why: 'Signal Blue (--focus-ring) is the only interaction colour',
    pattern: /focus(?:-within|-visible)?:ring-\(--color-accent\)/g,
    allow: {},
  },
  {
    name: 'bracket-z-index',
    why: 'write numeric z-index as z-60, not z-[60]',
    pattern: /(?<![\w-])z-\[\d+\]/g,
    allow: {},
  },
]

/** Comment lines describe classes without applying them. */
const COMMENT_LINE = /^(?:\*|\/\/|\/\*|\{\/\*)/

function countMatches(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles(SRC)) {
    let count = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (COMMENT_LINE.test(line.trim())) continue
      count += line.match(pattern)?.length ?? 0
    }
    if (count) counts[relative(SRC, file)] = count
  }
  return counts
}

describe('design lint', () => {
  for (const rule of RULES) {
    it(`${rule.name}: ${rule.why}`, () => {
      expect(countMatches(rule.pattern)).toEqual(rule.allow)
    })
  }
})

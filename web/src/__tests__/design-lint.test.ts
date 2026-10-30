/**
 * Design-system guard (DESIGN.md). Scans app source for class patterns that
 * drift from the tokens: sub-floor type, un-tokenized radius, ad hoc shadows,
 * raw black/white, hard-coded scrims, legacy arbitrary-var syntax, motion
 * written outside the `--motion-*` / `--ease-*` tokens, and so on.
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
      // QR code: scanners need a white quiet zone in both themes.
      'components/ConnectQrCode.tsx': 1,
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
    name: 'faint-focus-ring',
    why: 'keyboard focus is a solid 2px ring or outline in --focus-ring; a 40% one is hard to see',
    pattern: /focus-visible:(?:ring|outline)-\(--focus-ring\)\/\d+/g,
    allow: {
      // The composer's attachment strip: the composer stays exactly as it is.
      'components/FilePreviewStrip.tsx': 5,
    },
  },
  {
    name: 'pulsing-text',
    why: 'pulse only a live dot, a mark or a skeleton; pulsing words are hard to read (state goes in a chip or a static "…")',
    pattern: /(?<![\w-])animate-pulse(?![\w-])/g,
    allow: {
      // Skeleton blocks.
      'components/ui/skeleton.tsx': 1,
      // Live dots and marks, not text.
      'components/ui/goal-ring.tsx': 1,
      'components/AgentChatView/index.tsx': 1,
      'components/AppBackendPanel.tsx': 1,
      'components/WorkSummary.tsx': 1,
      'components/WorkspacePanel/GoalTabView.tsx': 1,
      // The running tool's dot, not its label.
      'components/ToolCall/index.tsx': 1,
    },
  },
  {
    name: 'bracket-z-index',
    why: 'write numeric z-index as z-60, not z-[60]',
    pattern: /(?<![\w-])z-\[\d+\]/g,
    allow: {},
  },
  // ── Motion (DESIGN.md → Motion) ──────────────────────────────────────────
  {
    name: 'transition-all',
    why: 'name the properties that change (transition-colors, -opacity, -transform); `all` also animates layout and focus rings',
    pattern: /(?<![\w-])transition-all(?![\w-])/g,
    allow: {},
  },
  {
    name: 'raw-duration-class',
    why: 'durations come from the tokens: duration-(--motion-instant|fast|base|slow|glacial)',
    pattern: /(?<![\w-])duration-(?:\d+|\[[^\]]*\])(?![\w-])/g,
    allow: {},
  },
  {
    name: 'animate-with-transition-duration',
    // A line that names a transition (transition-colors, …) may also time it.
    why: 'time tw-animate-css with animation-duration-(--motion-*); duration-* also sets transition-duration, which with no transition-* class animates every property (a tooltip slides in from 0,0)',
    pattern: /^(?!.*(?<![\w:-])transition(?![\w]))(?=.*(?<![\w-])animate-(?:in|out)(?![\w-])).*(?<![\w-])duration-\(/g,
    allow: {},
  },
  {
    name: 'raw-ease-class',
    why: 'Tailwind\'s ease-in/out curves are not ours; write ease-(--ease-out) or ease-(--ease-in-out)',
    pattern: /(?<![\w(-])ease-(?:in|out|in-out|linear)(?![\w)-])/g,
    allow: {},
  },
  {
    name: 'raw-seconds-duration',
    why: 'framer-motion durations come from DURATIONS_S in lib/motion.ts',
    pattern: /\bduration:\s*0?\.\d+/g,
    allow: {},
  },
  {
    name: 'raw-cubic-bezier',
    why: 'curves come from EASINGS in lib/motion.ts or var(--ease-*)',
    pattern: /cubic-bezier\(\s*[\d.]/g,
    allow: {},
  },
  {
    name: 'raw-unmount-delay',
    why: 'an exit timer must equal its animation, so pass a token (DURATIONS_S.fast * 1000), not a number',
    pattern: /useDeferredUnmount\([^)]*,\s*\d+\s*\)/g,
    allow: {},
  },
  {
    name: 'layout-transition',
    why: 'animating width/height/inset/margin/padding re-lays-out every frame; move with translate or scale, reveal with grid rows (ui/collapsible)',
    pattern: /transition-\[[^\]]*\b(?:width|height|left|right|top|bottom|inset|margin|padding)\b/g,
    allow: {
      // Pill ↔ card morph of a fixed notice: nothing lays out around it.
      'components/UpdateCard.tsx': 1,
      'components/LspInstallPrompt.tsx': 1,
      // The current page dot widens into a pill among its few siblings.
      'components/FileLightbox.tsx': 1,
    },
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

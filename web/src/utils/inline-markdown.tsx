/**
 * Inline-only markdown for short, model-authored strings.
 *
 * Deliberately its own module rather than a call to ``LazyMarkdownBlock``,
 * which already code-splits the full ``markdown.tsx`` graph
 * (@tanstack/markdown, Mermaid) into an on-demand chunk. So the reason is
 * *not* initial bundle size — that chunk is never in the eager path. It is:
 *
 * - **No async boundary for one line.** Going through the lazy renderer means a
 *   chunk fetch plus a Suspense fallback to draw a question label; the card
 *   would visibly reflow on open.
 * - **Block markup is wrong here.** That renderer emits an ``oa-prose``
 *   wrapper and ``<p>`` elements, which break a compact card's layout.
 * - **No links, by design.** See ``INLINE_MARKERS`` below: these strings are
 *   model-authored and sit in a card the user is being asked to act on, so a
 *   clickable target the model chose is a phishing surface.
 * - **Cheap tests.** Components rendering this need no markdown graph loaded.
 */
import { memo, useMemo } from 'react'
import { MathSpan } from '@/utils/markdown-math'



/**
 * Inline markers, in precedence order. ``**bold**`` must be tried before
 * ``*italic*`` or the italic branch would claim the first two asterisks.
 *
 * Deliberately absent:
 *
 * - **links.** ``[text](url)`` is left as literal text. These strings are
 *   model-authored and appear in a card the user is being asked to act on, so a
 *   clickable target the model chose is a phishing surface; showing the raw URL
 *   is both safer and more informative.
 * - **images, html, blocks.** Nothing here produces markup from input, and the
 *   output is React nodes rather than HTML, so untrusted text cannot inject
 *   elements at all.
 *
 * Each body must start and end with a non-space so ``a * b * c`` and a stray
 * ``**`` stay literal. ``_italic_`` requires non-alphanumeric boundaries, which
 * keeps ``snake_case_names`` intact.
 */
const INLINE_MARKERS =
  /`([^`\n]+)`|\$(?!\s)([^$\n]+?)(?<![\s\\])\$|\*\*(\S(?:[^*\n]*\S)?)\*\*|\*(\S(?:[^*\n]*\S)?)\*|(?<![A-Za-z0-9])_(\S(?:[^_\n]*\S)?)_(?![A-Za-z0-9])/g

/** Code-only subset, for text where emphasis would just be noise. */
const INLINE_CODE_ONLY = /`([^`\n]+)`/g

const INLINE_CODE_CLASS =
  'rounded-xs bg-(--bg-key) px-1 py-0.5 font-mono text-[0.9em] text-(--color-text)'

function tokenizeInline(text: string, variant: 'full' | 'code'): React.ReactNode[] {
  const pattern = variant === 'code' ? INLINE_CODE_ONLY : INLINE_MARKERS
  // Shared module-level regexes are stateful under /g; reset before each use.
  pattern.lastIndex = 0

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (variant === 'code') {
      const [, code] = match
      const key = `${match.index}`
      if (code !== undefined) {
        nodes.push(
          <code key={key} className={INLINE_CODE_CLASS}>
            {code}
          </code>,
        )
      }
    } else {
      const [, code, math, bold, star, underscore] = match
      const key = `${match.index}`
      if (code !== undefined) {
        nodes.push(
          <code key={key} className={INLINE_CODE_CLASS}>
            {code}
          </code>,
        )
      } else if (math !== undefined) {
        nodes.push(<MathSpan key={key} math={math} />)
      } else if (bold !== undefined) {
        nodes.push(<strong key={key}>{bold}</strong>)
      } else {
        nodes.push(<em key={key}>{star ?? underscore}</em>)
      }
    }
    cursor = match.index + match[0].length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

/**
 * Render a short, model-authored string with inline formatting only.
 *
 * Used for ``ask_user`` text, where the agent writes prose the user
 * reads before choosing — inline code carries most of the meaning (flags, file
 * names, commands) and anything block-level would break the card's layout.
 *
 * ``variant="code"`` renders inline code and nothing else.
 */
export const InlineMarkdown = memo(function InlineMarkdown({
  text,
  variant = 'full',
  className,
}: {
  text: string
  variant?: 'full' | 'code'
  className?: string
}) {
  const nodes = useMemo(() => tokenizeInline(text, variant), [text, variant])
  return <span className={className}>{nodes}</span>
})

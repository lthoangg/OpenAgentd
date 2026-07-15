/**
 * InboxBubble — renders inter-agent inbox messages.
 *
 * - Left-aligned, muted border (distinct from user bubbles)
 * - Markdown rendered through the shared lazy markdown renderer
 * - Auto-collapses when content exceeds COLLAPSE_LINES
 *   Collapsed: first N lines + overlaid expand button
 *   Expanded:  full content + overlaid collapse button
 */

import { useState, useMemo } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'

/** Me change N here to tune collapse threshold */
const COLLAPSE_LINES = 3

/** Me also collapse very long wrapped single-line messages. */
const COLLAPSE_CHARS = 700

/** Me how much of the preview bottom gets softened while collapsed. */
const FADE_LINES = 2

interface InboxBubbleProps {
  content: string
  fromAgent: string
  /** Compact sizing for split-view panels */
  compact?: boolean
}

export function InboxBubble({ content, fromAgent, compact = false }: InboxBubbleProps) {
  const [expanded, setExpanded] = useState(false)

  const label = fromAgent
  // Me strip "[agent_name]: " prefixes — label already shows sender.
  // Instance handles include suffixes like `#1`.
  const stripped = useMemo(
    () => content.replace(/^\[[\w#-]+\]:\s*/gm, '').trim(),
    [content],
  )

  const lines = stripped.split('\n')
  const needsCollapse = lines.length > COLLAPSE_LINES || stripped.length > COLLAPSE_CHARS

  // Me slice visible content when collapsed
  const visibleContent = needsCollapse && !expanded
    ? lines.length > COLLAPSE_LINES
      ? lines.slice(0, COLLAPSE_LINES).join('\n')
      : `${stripped.slice(0, COLLAPSE_CHARS).trimEnd()}...`
    : stripped

  // Me size tokens — compact vs normal
  const textSize  = compact ? 'text-xs'    : 'text-sm'
  const maxWidth  = compact ? 'max-w-[88%]' : 'max-w-[78%]'
  const padding   = compact ? 'px-3 py-2'  : 'px-4 py-3'
  const labelSize = compact ? 'text-[10px]' : 'text-xs'
  const fadeHeight = compact
    ? `${FADE_LINES * 1.4}rem`
    : `${FADE_LINES * 1.6}rem`

  return (
    <div className="mb-4 flex justify-start">
      <div
        className={[
          maxWidth,
          padding,
          textSize,
          'relative rounded-sm',
          'border border-(--color-border) bg-(--bg-card)',
          'leading-relaxed text-(--color-text) shadow-sm',
          'overflow-hidden',
        ].join(' ')}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className={`${labelSize} font-semibold tracking-wide text-(--color-text-2)`}>
            Message from {label}
          </p>

          {needsCollapse && (
            <button
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              title={expanded ? 'Collapse' : 'Expand'}
              className={[
                'flex items-center justify-center shrink-0',
                'rounded-md border border-(--color-border)',
                'bg-(--bg-page) text-(--color-text-muted)',
                compact ? 'h-4 w-4' : 'h-5 w-5',
                'transition-all duration-150',
                'hover:border-(--color-border-strong) hover:text-(--color-text)',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
                'active:scale-90',
              ].join(' ')}
            >
              {expanded
                ? <ChevronUp size={compact ? 10 : 12} />
                : <ChevronDown size={compact ? 10 : 12} />}
            </button>
          )}
        </div>

        {/* Me markdown content */}
        <div className="oa-prose">
          <LazyMarkdownBlock content={visibleContent} />
        </div>

        {needsCollapse && !expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 backdrop-blur-[1px]"
            style={{
              height: fadeHeight,
              background: 'linear-gradient(to bottom, transparent 0%, var(--bg-card) 90%)',
            }}
          />
        )}
      </div>
    </div>
  )
}

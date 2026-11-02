/**
 * Thinking — the model's reasoning trace, as a transcript Row (DESIGN.md →
 * Transcript rows).
 *
 * The trace streams in place with no label, and stays open once done:
 * reasoning is part of the answer, not something to dig for.
 * The trace sits inline in small mono text (no quote bar, no italics), so it
 * reads as reasoning beside the answer; section headers are bold.
 *
 * Reasoning streams from providers like OpenAI's ``/responses`` API as a
 * sequence of sections, each beginning with a bold ``**Title**`` header.
 * ``splitSections`` (see ``@/utils/thinking``) parses the raw text into
 * ordered sections; each header is rendered as a styled run above its body.
 * Inline ``**bold**`` runs inside the body are NOT Markdown-rendered —
 * reasoning is rarely complex prose; only the section headers get emphasis.
 *
 * A long trace stops at a cap (``max-h-[min(24rem,50vh)]``) and scrolls inside
 * itself, so a page of reasoning does not push the answer off screen. While
 * streaming, the box follows its newest line unless the reader scrolled up in
 * it. "Show full reasoning" lifts the cap; "Show less" puts it back.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { splitSections } from '@/utils/thinking'
import { useSmoothStream } from '@/hooks/useSmoothStream'

interface ThinkingProps {
  content: string
  isStreaming?: boolean
  /** How long the model reasoned, when the server recorded it. Not shown. */
  durationMs?: number
}

export function Thinking({ content, isStreaming = false }: ThinkingProps) {
  const smoothedContent = useSmoothStream(content, isStreaming)
  const traceRef = useRef<HTMLDivElement>(null)
  // The trace is taller than its cap. Kept once seen (a trace only grows
  // while it streams), and for an opened trace, which no longer overflows.
  const [overflowing, setOverflowing] = useState(false)
  const [full, setFull] = useState(false)
  // Whether the capped box sits at its end, so streaming keeps it there.
  const followingRef = useRef(true)

  useLayoutEffect(() => {
    const el = traceRef.current
    if (!el || full || overflowing) return
    if (el.scrollHeight > el.clientHeight + 1) setOverflowing(true)
  }, [smoothedContent, full, overflowing])

  // A narrower column wraps the same text onto more lines.
  useEffect(() => {
    const el = traceRef.current
    if (!el || full || overflowing || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (el.scrollHeight > el.clientHeight + 1) setOverflowing(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [full, overflowing])

  useLayoutEffect(() => {
    const el = traceRef.current
    if (el && isStreaming && !full && followingRef.current) el.scrollTop = el.scrollHeight
  }, [smoothedContent, isStreaming, full])

  // Whitespace-only traces (a provider's blank first delta) would render an
  // empty, margined box.
  if (!content.trim()) return null

  const sections = splitSections(smoothedContent)
  const capped = !full

  return (
    <div className="my-1 min-w-0" data-thinking>
      <div
        ref={traceRef}
        data-thinking-trace
        // A box that scrolls must take focus, or a keyboard cannot reach the rest.
        tabIndex={capped && overflowing ? 0 : undefined}
        role={capped && overflowing ? 'region' : undefined}
        aria-label={capped && overflowing ? 'Reasoning' : undefined}
        onScroll={(event) => {
          const el = event.currentTarget
          followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className={cn(
          'selectable-text mt-1 mb-2 min-w-0 space-y-2 font-mono text-xs leading-relaxed text-(--color-text-2) [overflow-wrap:anywhere]',
          capped && 'max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain',
        )}
      >
      {sections.map((s, i) => (
        <div key={i} className="min-w-0">
          {s.header && (
            <p className="mb-1 break-words font-semibold text-(--color-text) [overflow-wrap:anywhere]">{s.header}</p>
          )}
          {s.body && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{s.body}</p>}
        </div>
      ))}
      </div>
      {(overflowing || full) && (
        <button
          type="button"
          aria-expanded={full}
          onClick={() => setFull((value) => !value)}
          className="-mt-1 mb-2 inline-flex h-6 items-center rounded-xs px-1.5 text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9 pointer-coarse:px-2.5"
        >
          {full ? 'Show less' : 'Show full reasoning'}
        </button>
      )}
    </div>
  )
}

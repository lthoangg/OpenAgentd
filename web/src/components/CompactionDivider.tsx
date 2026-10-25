/**
 * CompactionDivider — inline marker rendered when the summarisation hook
 * compacts the session's context window.
 *
 * Two visual elements:
 *   1. A horizontal-rule + centred label ("Session compacting…" /
 *      "Session compacted" / "Compaction failed") so users see where in
 *      the transcript context was trimmed.
 *   2. (Optional) the summary body itself rendered as Markdown beneath
 *      the divider — when ``summary`` is non-empty. The body is the
 *      authoritative artefact of what got compacted into; surfacing it
 *      lets the user audit what the LLM will see going forward.
 *      It is collapsed by default: the label becomes a toggle so a long
 *      summary does not fill the transcript. Open, the divider pins to the
 *      top of the transcript while the summary scrolls under it, and a
 *      Collapse row ends the summary (``useStickyFold``, as the reader
 *      fold does).
 *
 * While ``state === 'compacting'`` the body streams in via SSE
 * ``summarization_content`` deltas (see useAgentStore reducer). The
 * divider re-renders on every delta, so once expanded the user sees the
 * summary being written in real time.
 */
import { useId } from 'react'
import { ChevronRight, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Collapsible } from '@/components/ui/collapsible'
import { PINNED_HEADER, useStickyFold } from '@/hooks/useStickyFold'
import { MarkdownBlock } from '@/utils/markdown'

interface CompactionDividerProps {
  state: 'compacting' | 'compacted'
  error?: boolean
  /** Summary body. Streams during ``compacting``; final text after ``compacted``. */
  summary?: string
  /** Forwarded to ``MarkdownBlock`` for in-prose attachment / image resolution. */
  sessionId?: string
  /** Whether the summary is still being streamed in via SSE deltas.
   *  Defaults to ``true`` when ``state === 'compacting'`` so that
   *  ``MarkdownBlock`` activates the smooth-stream hook and renders
   *  each incoming chunk as it arrives. Pass ``false`` explicitly to
   *  suppress animation (e.g. during cold-replay where the content is
   *  already complete). */
  isStreaming?: boolean
}

export function CompactionDivider({ state, error, summary, sessionId, isStreaming }: CompactionDividerProps) {
  const { open, setOpen, close, anchorRef } = useStickyFold()
  const bodyId = useId()
  // Default: streaming is active whenever the block is still in the compacting state.
  const effectiveIsStreaming = isStreaming ?? state === 'compacting'
  const label = error
    ? 'Compaction failed'
    : state === 'compacting'
      ? 'Session compacting'
      : 'Session compacted'

  const tone = error
    ? 'text-(--color-error)'
    : state === 'compacting'
      ? 'text-(--color-text-subtle)'
      : 'text-(--color-text-2)'

  const trimmed = summary?.trim() ?? ''
  const showBody = trimmed.length > 0 && !error
  const content = effectiveIsStreaming ? (summary ?? '') : trimmed
  const pinned = showBody && open

  const labelContent = (
    <>
      {label}
      {state === 'compacting' && !error && (
        <span className="ml-1 inline-block animate-pulse">…</span>
      )}
    </>
  )

  return (
    <div role="region" aria-label={label} className="my-4 space-y-3">
      <div className={cn('flex items-center gap-3', pinned && cn(PINNED_HEADER, 'bg-(--bg-page)'))}>
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
        {showBody ? (
          <button
            ref={anchorRef}
            type="button"
            onClick={(event) => (open ? close(event.currentTarget) : setOpen(true))}
            aria-expanded={open}
            aria-controls={bodyId}
            className={cn(
              'inline-flex items-center gap-1 rounded-xs px-1 font-mono text-xs transition-colors duration-(--motion-instant) pointer-coarse:min-h-9 hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
              tone,
            )}
          >
            <span>{labelContent}</span>
            <ChevronRight
              size={12}
              aria-hidden
              className={cn('shrink-0 text-(--color-text-subtle) transition-transform duration-(--motion-fast) ease-(--ease-out)', open && 'rotate-90')}
            />
          </button>
        ) : (
          <span className={`font-mono text-xs ${tone}`}>{labelContent}</span>
        )}
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
      </div>

      <Collapsible open={pinned}>
        {/* Rendered as plain assistant-style prose (no card chrome): same look
            as a regular assistant text block, just dimmed via --color-text-2
            to signal it is a derived/system artefact rather than a fresh reply. */}
        <div id={bodyId} className="text-sm text-(--color-text-2)">
          <MarkdownBlock content={content} sessionId={sessionId} isStreaming={effectiveIsStreaming} />
        </div>
        <button
          type="button"
          onClick={(event) => {
            close(event.currentTarget)
            // This button goes with the summary; keep focus on the divider.
            anchorRef.current?.focus({ preventScroll: true })
          }}
          aria-controls={bodyId}
          className="mt-1 inline-flex items-center gap-1.5 py-1 font-mono text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) pointer-coarse:min-h-9 hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring)/40"
        >
          <ChevronUp size={13} aria-hidden className="shrink-0" />
          <span>Collapse</span>
        </button>
      </Collapsible>
    </div>
  )
}

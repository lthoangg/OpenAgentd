/**
 * Syntax-highlight overlay for the InputBar's textarea.
 *
 * Renders a mirror ``<div>`` directly behind the textarea using the same
 * font, line-height and wrap rules. The mirror paints the full message
 * text in normal foreground color, with committed ``@mention`` tokens
 * colored by kind — files in blue, folders in orange — same idea as a
 * code editor coloring identifiers vs types.
 *
 * The textarea on top sets ``color: transparent`` (only the caret remains
 * visible via ``caret-color``), so the user sees the overlay's text, not
 * a doubled-up render. Selection rectangles still draw via the textarea
 * because the browser owns selection chrome on the focused element.
 *
 * Same pattern Slate / CodeMirror / react-simple-code-editor use for
 * lightweight in-place highlighting without giving up textarea semantics
 * (paste, IME, mobile keyboards, undo stack).
 */
import { memo, useEffect, useMemo, useRef } from 'react'

import { buildMentionLookup, findCommittedMentions, type FileRef } from './InputBar.mentions'
import { MAX_TEXTAREA_HEIGHT } from './InputBar.autosize'

interface MentionOverlayProps {
  /** Current textarea value. */
  value: string
  /**
   * Range of the mention currently being typed (from ``findActiveMention``).
   * Excluded from highlighting so users don't see the color materialise on
   * every keystroke before they've committed the selection.
   */
  activeRange: { start: number; end: number } | null
  /** Ref to the textarea so we can mirror its scroll position. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /**
   * Workspace file/folder list used to validate committed mentions —
   * ``@nonexistent`` and ``@@`` get no color because they don't resolve.
   */
  fileRefs: readonly FileRef[]
  /** Explicitly selected mentions. */
  mentions?: string[]
}

function MentionOverlayComponent({
  value,
  activeRange,
  textareaRef,
  fileRefs,
  mentions,
}: MentionOverlayProps) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  // Build the token-resolution sets and token-kind maps once per ``fileRefs`` change.
  const { mentionLookup, kindByToken } = useMemo(() => {
    const lookup = buildMentionLookup(fileRefs)
    const kindMap = new Map<string, 'file' | 'directory'>()
    for (const ref of fileRefs) {
      if (ref.type === 'directory') {
        kindMap.set(`@${ref.path}`, 'directory')
        kindMap.set(`@${ref.path}/`, 'directory')
      } else {
        kindMap.set(`@${ref.path}`, 'file')
      }
    }
    return { mentionLookup: lookup, kindByToken: kindMap }
  }, [fileRefs])

  const ranges = useMemo(
    () => findCommittedMentions(value, activeRange, mentionLookup, mentions),
    [value, activeRange, mentionLookup, mentions],
  )

  // Keep the mirror's scroll position in lock-step with the textarea so
  // the colored text stays aligned when the message overflows the bar's
  // max-height. Re-runs whenever the range count or value length changes:
  // the overlay returns ``null`` on an empty value (see below), so without
  // ``value.length`` in the deps the listener would never attach for the
  // first non-empty render, leaving long mention-less messages frozen in
  // place while the caret scrolls.
  useEffect(() => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    // Only vertical sync — horizontal overflow can't happen because both
    // layers use ``whitespace: pre-wrap`` + ``break-words``.
    const sync = () => {
      mirror.scrollTop = ta.scrollTop
    }
    sync()
    ta.addEventListener('scroll', sync)
    return () => ta.removeEventListener('scroll', sync)
  }, [textareaRef, ranges.length, value.length])

  // No mentions and no text? Skip the mirror entirely.
  if (ranges.length === 0 && value.length === 0) return null

  // Build alternating plain-text + colored-mention spans in one pass.
  // Files paint in ``--accent-blue-text``, directories in
  // ``--accent-orange-text``; both tokens are defined per-theme to stay
  // readable against the surface, unlike ``--color-accent`` which equals
  // ``--color-text`` in the dark palette. Fallback to file styling when
  // the token isn't in the map (shouldn't happen — ``findCommittedMentions``
  // only returns ranges that resolved against ``fileRefs``).
  const segments: React.ReactNode[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) segments.push(value.slice(cursor, r.start))
    const token = value.slice(r.start, r.end)
    const kind = kindByToken.get(token) ?? 'file'
    const colorClass =
      kind === 'directory'
        ? 'text-(--accent-orange-text)'
        : 'text-(--accent-blue-text)'
    segments.push(
      <span
        key={r.start}
        data-testid="mention-chip"
        data-mention-kind={kind}
        className={colorClass}
      >
        {token}
      </span>,
    )
    cursor = r.end
  }
  if (cursor < value.length) segments.push(value.slice(cursor))
  // Trailing newline guard: a value ending in ``\n`` would otherwise
  // cause the mirror to render one line shorter than the textarea
  // (browsers collapse a trailing newline in ``white-space: pre-wrap``).
  if (value.endsWith('\n')) segments.push('\u200b')

  return (
    <div
      ref={mirrorRef}
      aria-hidden="true"
      // ``inset-0`` pins the mirror to the wrapper (which equals the
      // textarea's box). Wrapping/font classes mirror the textarea
      // exactly so glyph positions line up character-for-character.
      // ``text-(--color-text)`` paints the non-mention text in the
      // normal foreground; the per-span color override above paints
      // mention tokens in blue (files) or orange (folders).
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-sm leading-relaxed text-(--color-text)"
      // Mirrors the textarea's height cap (MAX_TEXTAREA_HEIGHT).
      style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
    >
      {segments}
    </div>
  )
}

const sameArray = (a?: string[], b?: string[]) => {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

export const MentionOverlay = memo(MentionOverlayComponent, (prev, next) => {
  const prevRange = prev.activeRange
  const nextRange = next.activeRange
  const sameRange = prevRange === nextRange || (
    prevRange != null &&
    nextRange != null &&
    prevRange.start === nextRange.start &&
    prevRange.end === nextRange.end
  )
  return prev.value === next.value &&
    prev.fileRefs === next.fileRefs &&
    prev.textareaRef === next.textareaRef &&
    sameRange &&
    sameArray(prev.mentions, next.mentions)
})

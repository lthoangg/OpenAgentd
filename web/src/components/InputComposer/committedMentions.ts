/**
 * The draft's committed ``@mention`` tokens: the paths picked from the
 * mention menu (or appended from outside) that render as chips and are sent
 * as mentions. A token is one unit: a caret inside it selects it whole, and
 * Backspace or Delete next to it removes it whole. A mention whose token is
 * typed over or deleted is dropped.
 */
// Not compiled, as when this code was part of InputComposer, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { getExplicitMentionRanges } from './mentions'

export function useCommittedMentions({
  value,
  setValue,
  textareaRef,
  resize,
}: {
  value: string
  setValue: Dispatch<SetStateAction<string>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  resize: () => void
}) {
  const [mentions, setMentions] = useState<string[]>([])

  // Single source of truth for where committed ``@mention`` tokens live in
  // the current value. Memoized once per (value, mentions) change and shared
  // by atomic selection (syncMention), atomic deletion, and mention pruning —
  // previously each of those re-scanned the text with its own copy of the
  // boundary rules on every keystroke/caret move.
  const mentionRanges = useMemo(
    () => getExplicitMentionRanges(value, mentions),
    [value, mentions],
  )

  // Synchronise mentions with the actual textarea value: a mention survives
  // only while its ``@path`` / ``@path/`` token still resolves to a range in
  // the text (i.e. the user hasn't typed over or deleted it).
  useEffect(() => {
    setMentions((prev) => {
      const present = new Set(mentionRanges.map((r) => r.path))
      const next = prev.filter((path) => present.has(path))
      return next.length !== prev.length ? next : prev
    })
  }, [mentionRanges])

  /**
   * Select the whole mention under a collapsed caret, so that any edit or
   * delete applies to it as a whole. True when the caret was inside one.
   */
  const selectWholeMention = useCallback((el: HTMLTextAreaElement, caret: number): boolean => {
    // ``onSelect`` also fires mid-typing, before React re-renders — in that
    // window ``el.value`` is ahead of the ``value`` state the memoized
    // ranges were computed from, so fall back to a fresh scan.
    const ranges = el.value === value
      ? mentionRanges
      : getExplicitMentionRanges(el.value, mentions)
    const hit = ranges.find((r) => caret > r.start && caret < r.end)
    if (!hit) return false
    requestAnimationFrame(() => {
      el.setSelectionRange(hit.start, hit.end)
    })
    return true
  }, [value, mentionRanges, mentions])

  const handleAtomicMentionDeletion = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false
    const el = textareaRef.current
    if (!el || el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    const targetIdx = e.key === 'Backspace' ? caret - 1 : caret
    // Keydown fires before the value changes, so the memoized ranges are
    // guaranteed fresh here.
    const hit = mentionRanges.find((r) => targetIdx >= r.start && targetIdx < r.end)
    if (!hit) return false

    e.preventDefault()
    const before = value.slice(0, hit.start)
    const after = value.slice(hit.end)
    const next = before + after
    setValue(next)

    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(hit.start, hit.start)
      resize()
    })
    return true
  }, [mentionRanges, resize, setValue, textareaRef, value])

  return { mentions, setMentions, selectWholeMention, handleAtomicMentionDeletion }
}

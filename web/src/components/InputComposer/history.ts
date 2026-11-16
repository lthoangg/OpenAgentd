/**
 * Prompt history: ``↑`` in an empty composer recalls the last sent prompt,
 * ``↑``/``↓`` walk older and newer, and ``↓`` past the newest returns to an
 * empty draft. Prompts sent here come first, then the parent's (loaded chat
 * history), trimmed and deduplicated.
 */
// Not compiled, as when this code was part of InputComposer, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { splitDesignFeedback, type DesignFeedback } from '@/lib/design-feedback'
import type { SuggestionRange } from './suggestionEngine'

export function buildHistoryEntries(
  localHistory: string[],
  historyPrompts: string[],
): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const prompt of [...localHistory, ...historyPrompts]) {
    const trimmed = prompt.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    entries.push(trimmed)
  }
  return entries
}

export function usePromptHistory({
  historyPrompts,
  value,
  designFeedback,
  setValue,
  setDesignFeedback,
  setMentionRange,
  setSnippetRange,
  resize,
  textareaRef,
  onHistoryRecall,
}: {
  historyPrompts: string[]
  value: string
  designFeedback: DesignFeedback[]
  setValue: Dispatch<SetStateAction<string>>
  setDesignFeedback: Dispatch<SetStateAction<DesignFeedback[]>>
  setMentionRange: Dispatch<SetStateAction<SuggestionRange>>
  setSnippetRange: Dispatch<SetStateAction<SuggestionRange>>
  resize: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onHistoryRecall?: (prompt: string | null) => void
}) {
  const [localHistory, setLocalHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const history = useMemo(
    () => buildHistoryEntries(localHistory, historyPrompts),
    [localHistory, historyPrompts],
  )

  const navigateHistory = useCallback((dir: 'up' | 'down') => {
    if (history.length === 0) return false
    const direction = dir === 'up' ? 1 : -1
    // Attached design feedback counts as a draft: ↑ must not replace it.
    const canEnterHistory = dir === 'up' && value.length === 0 && designFeedback.length === 0 && historyIndex === -1
    const inHistory = historyIndex >= 0

    if (canEnterHistory || inHistory) {
      const nextIndex = canEnterHistory ? 0 : historyIndex + direction
      if (nextIndex < 0) {
        setHistoryIndex(-1)
        setValue('')
        setDesignFeedback([])
        setMentionRange(null)
        setSnippetRange(null)
        requestAnimationFrame(resize)
        onHistoryRecall?.(null)
        return true
      }
      if (nextIndex >= history.length) return true
      const next = history[nextIndex]
      // A recalled prompt's design feedback comes back as chips.
      const recalled = splitDesignFeedback(next)
      setHistoryIndex(nextIndex)
      setValue(recalled.text)
      setDesignFeedback(recalled.blocks)
      setMentionRange(null)
      setSnippetRange(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        el?.setSelectionRange(recalled.text.length, recalled.text.length)
        resize()
      })
      onHistoryRecall?.(next)
      return true
    }
    return false
  }, [history, value, designFeedback.length, historyIndex, resize, setValue, setDesignFeedback, setMentionRange, setSnippetRange, textareaRef, onHistoryRecall])

  const handleHistoryKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length > 0) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
      const handled = navigateHistory(e.key === 'ArrowUp' ? 'up' : 'down')
      if (handled) {
        e.preventDefault()
        return true
      }
    }
    return false
  }, [history.length, navigateHistory])

  /** A sent message becomes the newest entry (at most 100 kept here). */
  const rememberPrompt = useCallback((message: string) => {
    setLocalHistory((prev) =>
      prev[0] === message ? prev : [message, ...prev].slice(0, 100),
    )
  }, [])

  return { setHistoryIndex, handleHistoryKeyDown, rememberPrompt }
}

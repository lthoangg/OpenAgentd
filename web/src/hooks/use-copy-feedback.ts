import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a copy control reads "Copied" before it goes back to "Copy". */
export const COPIED_MS = 1500

/**
 * Clipboard write with a brief ``copied`` flag for the control that asked.
 * Clipboard access is best effort: a refusal leaves the flag off and
 * resolves ``false``. The reset timer stops with the component.
 */
export function useCopyFeedback(resetMs = COPIED_MS) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return false
      }
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), resetMs)
      return true
    },
    [resetMs],
  )

  return { copied, copy }
}

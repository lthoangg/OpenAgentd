/**
 * useContainerSelectAll — container-aware Cmd+A / Ctrl+A handler.
 *
 * Problem: the browser's native "Select All" (⌘A / Ctrl+A) selects
 * *everything* on the page — the entire document. When focus is inside a
 * scoped content zone (e.g. a file-preview panel, a code-block, or any
 * element carrying ``data-select-container``) the user almost always wants
 * to select only the content *within that zone*, not the whole page.
 *
 * Solution: a single window-level ``keydown`` listener that runs **before**
 * other handlers (capture phase). When the focused element (or its closest
 * ancestor) carries the ``data-select-container`` attribute, we:
 *   1. Prevent the OS-level Select-All default.
 *   2. Stop the event from reaching other handlers that might re-fire it.
 *   3. Create a ``Selection`` that spans all text nodes inside the container.
 *
 * Elements that want this behaviour simply add ``data-select-container`` to
 * the scrollable/scoped wrapper — no per-component hook needed.
 *
 * Exceptions:
 *  - Mobile OS (ios / android) — touch devices have no hardware modifier
 *    keys in normal use; virtual keyboards never fire Cmd/Ctrl+A. We skip
 *    the listener entirely so it never interferes with long-press select-all
 *    or any native touch-selection behaviour.
 *  - ``<input>`` / ``<textarea>`` already scope their own Select-All
 *    natively; we skip those so typing stays unaffected.
 *  - Elements with ``contenteditable`` are also skipped.
 */

import { useEffect } from 'react'
import { getPlatform } from '@/hooks/use-platform'
import { findSelectContainer, isPrimaryShortcut } from '@/lib/keyboard-shortcut'

export function useContainerSelectAll(): void {
  useEffect(() => {
    const { os } = getPlatform()

    // No hardware modifier keys on touch-only devices — skip entirely so
    // we never interfere with native long-press / touch-selection on iOS
    // or Android.
    if (os === 'ios' || os === 'android') return

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'a' && e.key !== 'A') return
      if (!isPrimaryShortcut(e, os)) return

      const active = document.activeElement as Element | null

      // Native form controls already handle Select-All themselves.
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }

      // Walk up from the focused element to find a container scope.
      const container = findSelectContainer(active)
      if (!container) return

      // We found a scoped container — prevent OS Select-All and bubble.
      e.preventDefault()
      e.stopPropagation()

      // Select all text content inside the container using the Selection API.
      const selection = window.getSelection()
      if (!selection) return

      const range = document.createRange()
      range.selectNodeContents(container)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    // Capture phase so we run before React's synthetic event system and
    // before any component-level keydown handlers.
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [])
}

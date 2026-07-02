import { useEffect } from 'react'
import { isEditableTarget } from '@/lib/is-editable-target'

/**
 * Chromium/WebView2/WKWebView all treat a bare Backspace outside of an
 * editable element as "navigate back" by default (the old IE-era
 * shortcut). We're a single-page app with our own routing, so that
 * default would silently blow away in-progress chat / panel state —
 * e.g. clicking a message bubble to focus it, then pressing Backspace
 * to delete a stray character, would instead pop the whole screen.
 *
 * Swallow it globally; editable elements (inputs, textareas, the chat
 * composer, contenteditable areas) are explicitly exempted so normal
 * text editing is untouched.
 */
export function usePreventBackspaceNavigation(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' || e.defaultPrevented) return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}

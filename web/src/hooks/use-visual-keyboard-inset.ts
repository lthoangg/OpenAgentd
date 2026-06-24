import { useEffect, useState } from 'react'

import { getPlatform } from '@/hooks/use-platform'

function computeKeyboardInset(): number {
  if (typeof window === 'undefined' || !window.visualViewport) return 0

  const viewport = window.visualViewport
  const viewportBottom = viewport.offsetTop + viewport.height
  const inset = window.innerHeight - viewportBottom
  return Math.max(0, Math.round(inset))
}

/**
 * Tracks the soft-keyboard occlusion reported by VisualViewport.
 *
 * iOS WKWebView resizes/moves the visual viewport when the keyboard opens but
 * does not always relayout fixed/docked UI as expected. Returning an explicit
 * bottom inset lets mobile composers stay above the keyboard while preserving
 * normal safe-area padding when the keyboard is closed.
 */
export function useVisualKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const { isTauri, os } = getPlatform()
    const isMobileShell = isTauri && (os === 'ios' || os === 'android')
    if (!isMobileShell || typeof window === 'undefined' || !window.visualViewport) return undefined

    let frame = 0
    const update = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = computeKeyboardInset()
        setInset(next)
        document.documentElement.style.setProperty('--keyboard-inset-bottom', `${next}px`)
      })
    }

    const handleFocusOut = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const active = document.activeElement
        if (!active || !active.matches('input, textarea, [contenteditable="true"]')) {
          setInset(0)
          document.documentElement.style.setProperty('--keyboard-inset-bottom', '0px')
        }
      })
    }

    update()
    window.visualViewport.addEventListener('resize', update)
    window.visualViewport.addEventListener('scroll', update)
    window.addEventListener('focusout', handleFocusOut)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.documentElement.style.removeProperty('--keyboard-inset-bottom')
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  return inset
}

import { useRef } from 'react'

/** Press handlers for a control that must not take focus from the message box. */
export interface KeepKeyboardHandlers {
  onPointerDown?: (e: React.PointerEvent) => void
  onMouseDown?: (e: React.MouseEvent) => void
}

/**
 * Phone: tapping Send, Steer, Stop or the mode toggle must not move focus
 * out of the textarea, or iOS drops the keyboard mid-conversation. Holding
 * the press's default keeps focus where it is; ``refocusAfterTap`` catches
 * a WebView that blurs anyway, still inside the tap so the keyboard stays.
 */
export function useKeepKeyboard(textareaRef: React.RefObject<HTMLTextAreaElement | null>, isMobile: boolean) {
  const hadFocusOnPressRef = useRef(false)
  const keepKeyboard: KeepKeyboardHandlers = isMobile
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          hadFocusOnPressRef.current = document.activeElement === textareaRef.current
          if (hadFocusOnPressRef.current) e.preventDefault()
        },
        onMouseDown: (e: React.MouseEvent) => {
          if (hadFocusOnPressRef.current) e.preventDefault()
        },
      }
    : {}
  const refocusAfterTap = () => {
    if (!isMobile || !hadFocusOnPressRef.current) return
    hadFocusOnPressRef.current = false
    if (document.activeElement !== textareaRef.current) textareaRef.current?.focus({ preventScroll: true })
  }
  return { keepKeyboard, refocusAfterTap }
}

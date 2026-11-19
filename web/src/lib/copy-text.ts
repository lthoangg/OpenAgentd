/**
 * Copy from a menu item or an icon button that has no label to change.
 *
 * A menu has closed by the time the text is on the clipboard, so nothing on
 * screen could say it worked: the app says "Copied" (briefly) or "Couldn't
 * copy", and a phone gives a soft tap. A button that can relabel itself
 * ("Copy" → "Copied") uses `hooks/use-copy-feedback` instead.
 */
import { softHapticFeedback } from '@/lib/haptics'
import { useToastStore } from '@/stores/useToastStore'

/** Long enough to read one word; the default toast stays more than twice as long. */
const COPIED_TOAST_MS = 1800

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    useToastStore.getState().push({ tone: 'error', title: "Couldn't copy" })
    return false
  }
  softHapticFeedback()
  useToastStore.getState().push({ tone: 'success', title: 'Copied' }, COPIED_TOAST_MS)
  return true
}

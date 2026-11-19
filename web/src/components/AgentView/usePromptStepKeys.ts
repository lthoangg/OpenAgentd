import { getPlatform } from '@/hooks/use-platform'
import { promptStepKeys } from '@/lib/app-shortcuts'
import { useShortcuts } from '@/lib/keyboard/hooks'

/**
 * Previous / next prompt from the keyboard: ⌥⌘↑ / ⌥⌘↓ on macOS, Alt+↑ /
 * Alt+↓ elsewhere. Off macOS the keys carry no primary modifier, so they
 * are allowed from the message box, where the caret usually is.
 */
export function usePromptStepKeys(jump: (direction: -1 | 1) => void): void {
  const keys = promptStepKeys(getPlatform().os)
  useShortcuts(
    [
      { chord: keys.previous, handler: () => { jump(-1) } },
      { chord: keys.next, handler: () => { jump(1) } },
    ],
    { allowInEditable: true },
  )
}

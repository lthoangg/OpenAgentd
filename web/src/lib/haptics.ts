import { getPlatform } from '@/hooks/use-platform'

export function softHapticFeedback(): void {
  const { isTauri, os } = getPlatform()
  if (!isTauri || (os !== 'ios' && os !== 'android')) return

  try {
    navigator.vibrate?.(10)
  } catch {
    // Best-effort only. Some iOS WebViews expose no vibration API; long-press
    // behavior must never depend on haptics succeeding.
  }
}

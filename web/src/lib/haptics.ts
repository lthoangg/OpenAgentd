import { getPlatform } from '@/hooks/use-platform'

/**
 * Best-effort haptic feedback for touch shells.
 *
 * Inside the Tauri mobile shell we use the native haptics plugin
 * (UIImpactFeedbackGenerator on iOS, Vibrator/VibrationEffect on
 * Android) so the tap feels like a real system long-press. Outside
 * the shell — or if the plugin call fails — we fall back to the web
 * Vibration API. Long-press behavior must never depend on haptics
 * succeeding, so every path swallows errors.
 */

function isTouchShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

function webVibrate(durationMs: number): void {
  try {
    navigator.vibrate?.(durationMs)
  } catch {
    // Some iOS WebViews expose no vibration API.
  }
}

async function nativeImpact(style: 'soft' | 'medium'): Promise<boolean> {
  try {
    const { impactFeedback } = await import('@tauri-apps/plugin-haptics')
    await impactFeedback(style)
    return true
  } catch {
    return false
  }
}

/** Light tick — selection changes, toggles, minor confirmations. */
export function softHapticFeedback(): void {
  if (!isTouchShell()) return
  void nativeImpact('soft').then((ok) => {
    if (!ok) webVibrate(10)
  })
}

/** Stronger thump — long-press activation, destructive confirms. */
export function mediumHapticFeedback(): void {
  if (!isTouchShell()) return
  void nativeImpact('medium').then((ok) => {
    if (!ok) webVibrate(20)
  })
}

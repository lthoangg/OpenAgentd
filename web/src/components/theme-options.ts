/**
 * The theme choices every theme control offers (Settings → General, the
 * drawer's toggle, the phone's toolbar, the palette), in one place.
 */
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePreference } from '@/lib/theme'

export const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference
  label: string
  Icon: typeof Monitor
}> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

/** The preference a tap on a one-button theme control moves to. */
export const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

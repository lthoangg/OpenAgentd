/**
 * useThemePreference — reactive access to the stored theme preference.
 *
 * Reads the current preference from localStorage and keeps it in sync across
 * tabs via `storage` events and across in-tab changes via a `CustomEvent`
 * dispatched from `setThemePreference`. The `resolved` value tracks the
 * current `light` / `dark` result after applying system-preference fallback.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  type ResolvedTheme,
  type ThemePreference,
  readStoredPreference,
  resolveTheme,
  setThemePreference as setStored,
  themeStorageKey,
} from '@/lib/theme'

const THEME_CHANGE_EVENT = 'oa-theme-change'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function useThemePreference(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(),
  )
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readStoredPreference()),
  )

  // React to preference changes from this tab (custom event) and other tabs
  // (native `storage` event).
  useEffect(() => {
    const sync = () => {
      const next = readStoredPreference()
      setPreferenceState(next)
      setResolved(resolveTheme(next))
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key === themeStorageKey()) sync()
    }
    const onCustom = () => sync()

    window.addEventListener('storage', onStorage)
    window.addEventListener(THEME_CHANGE_EVENT, onCustom)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(THEME_CHANGE_EVENT, onCustom)
    }
  }, [])

  // When preference is "system", track OS changes for the resolved value so
  // the UI reflects the current mode accurately.
  useEffect(() => {
    if (preference !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return

    const mql = window.matchMedia(MEDIA_QUERY)
    const handler = () => setResolved(mql.matches ? 'dark' : 'light')

    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next)
    setPreferenceState(next)
    setResolved(resolveTheme(next))
    // Notify other hook instances in the same tab.
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT))
  }, [])

  return { preference, resolved, setPreference }
}

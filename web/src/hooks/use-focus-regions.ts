/**
 * F6 / ⇧F6 move focus between the window's areas (``lib/focus-regions``),
 * remembering where focus was in each so coming back lands there. Works from
 * text fields too: F6 types nothing.
 */
import { useEffect } from 'react'

import { NEXT_REGION_CHORD, PREV_REGION_CHORD, cycleRegion, rememberRegionFocus } from '@/lib/focus-regions'
import { useShortcuts } from '@/lib/keyboard/hooks'

export function useFocusRegions(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined
    const onFocusIn = (event: FocusEvent) => rememberRegionFocus(event.target)
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [enabled])
  useShortcuts([
    { chord: NEXT_REGION_CHORD, handler: () => { cycleRegion(1) } },
    { chord: PREV_REGION_CHORD, handler: () => { cycleRegion(-1) } },
  ], { enabled, allowInEditable: true })
}

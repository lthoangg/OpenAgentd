import { useEffect } from 'react'
import { getPlatform } from '@/hooks/use-platform'
import { followDynamicType } from '@/lib/dynamic-type'

/**
 * Scale the UI with the iOS system text size (see ``lib/dynamic-type``).
 * iOS app only: macOS resolves the same body style to 13px, which would
 * read as a request for smaller text. Android scales text in the shell
 * instead (``ShellPlugin`` sets the WebView's ``textZoom`` from the system
 * font scale, capped at 125% like here).
 */
export function useDynamicType() {
  useEffect(() => {
    const { isTauri, os } = getPlatform()
    if (!isTauri || os !== 'ios') return
    return followDynamicType()
  }, [])
}

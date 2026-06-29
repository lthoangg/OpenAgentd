import * as React from "react"

const MOBILE_BREAKPOINT = 768
/** Shared media query used by both `useIsMobile` and `useMobileViewportGuards` to ensure consistent breakpoint detection. */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px), (max-height: 580px)`

export function useIsMobile() {
  // Initialise synchronously so the first render already knows the correct
  // value — avoids a one-frame flash of the desktop layout on mobile devices.
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.matchMedia(MOBILE_QUERY).matches
  })

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener("change", onChange)
    // Sync in case the viewport changed between the initial render and the
    // effect running (e.g. a fast orientation flip during hydration).
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}

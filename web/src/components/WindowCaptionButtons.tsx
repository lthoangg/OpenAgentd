/**
 * WindowCaptionButtons — Minimize, Maximize (Restore Down when maximized) and
 * Close at the top-right corner of the Windows app, whose window has no
 * system frame: the app header is the title bar (desktop/src-tauri/src/caption.rs).
 *
 * They are drawn the way Windows 11 draws its own: 46px wide, the header's
 * height, the system icon font's glyphs, a quiet fill on hover and a red one
 * on Close, dimmed while the window is in the background. They are not tab
 * stops, as the system's are not. Resting the mouse on Maximize opens Snap
 * Layouts, which Windows would only do for a system button.
 *
 * They sit above every layer of the page, as a title bar does; the header
 * leaves their width empty, and surfaces that reach the window's top edge
 * start below them (``html[data-window-caption]`` in index.css).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { hasWindowCaption, usePlatform } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'

/** How long the mouse rests on Maximize before Snap Layouts open. */
export const SNAP_LAYOUTS_DELAY_MS = 500

// Segoe Fluent Icons is Windows 11's icon font, Segoe MDL2 Assets Windows 10's:
// the glyphs the system caption buttons draw, at the size they draw them.
const GLYPH_STYLE: CSSProperties = { fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'", fontSize: 10 }
const GLYPH = {
  minimize: '\uE921',
  maximize: '\uE922',
  restore: '\uE923',
  close: '\uE8BB',
} as const

const BUTTON = 'flex h-full w-[46px] items-center justify-center transition-colors duration-(--motion-instant) focus-visible:outline-none'

export function WindowCaptionButtons() {
  const platform = usePlatform()
  const shown = hasWindowCaption(platform)
  const [maximized, setMaximized] = useState(false)
  const [focused, setFocused] = useState(() => typeof document === 'undefined' || document.hasFocus())
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!shown) return
    const root = document.documentElement
    root.setAttribute('data-window-caption', '')
    const win = getCurrentWindow()
    let live = true
    const syncMaximized = () => {
      void win.isMaximized().then((value) => { if (live) setMaximized(value) }).catch(() => {})
    }
    syncMaximized()
    const stopResized = win.onResized(syncMaximized)
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      live = false
      root.removeAttribute('data-window-caption')
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      void stopResized.then((stop) => stop()).catch(() => {})
    }
  }, [shown])

  useEffect(() => () => cancelSnapLayouts(), [])

  function cancelSnapLayouts() {
    if (snapTimer.current === null) return
    clearTimeout(snapTimer.current)
    snapTimer.current = null
  }

  function scheduleSnapLayouts(pointerType: string) {
    // Windows offers them to a mouse or pen resting on the button, not a touch.
    if (pointerType === 'touch') return
    cancelSnapLayouts()
    snapTimer.current = setTimeout(() => {
      snapTimer.current = null
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('show_snap_layouts'))
        .catch((err: unknown) => console.debug('Snap Layouts unavailable', err))
    }, SNAP_LAYOUTS_DELAY_MS)
  }

  if (!shown) return null

  const glyphTone = focused ? 'text-(--color-text)' : 'text-(--color-text-muted)'
  const quiet = cn(BUTTON, glyphTone, 'hover:bg-(--bg-key) active:bg-(--bg-key)/70')
  const maximizeLabel = maximized ? 'Restore Down' : 'Maximize'

  return (
    <div
      className="fixed right-0 top-0 z-80 flex h-(--spacing-app-header) select-none"
      data-no-drag
      data-window-caption-buttons
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Minimize"
        title="Minimize"
        className={quiet}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <span aria-hidden="true" style={GLYPH_STYLE}>{GLYPH.minimize}</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        className={quiet}
        onClick={() => void getCurrentWindow().toggleMaximize()}
        onPointerEnter={(event) => scheduleSnapLayouts(event.pointerType)}
        onPointerLeave={cancelSnapLayouts}
        onPointerDown={cancelSnapLayouts}
      >
        <span aria-hidden="true" style={GLYPH_STYLE}>{maximized ? GLYPH.restore : GLYPH.maximize}</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        title="Close"
        className={cn(
          BUTTON,
          glyphTone,
          'hover:bg-(--color-error) hover:text-(--color-text-on-accent) active:bg-(--color-error)/90 active:text-(--color-text-on-accent)',
        )}
        onClick={() => void getCurrentWindow().close()}
      >
        <span aria-hidden="true" style={GLYPH_STYLE}>{GLYPH.close}</span>
      </button>
    </div>
  )
}

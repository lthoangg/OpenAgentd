/**
 * TerminalView — thin attach/detach renderer over a store-owned terminal.
 *
 * The xterm instance and WebSocket live in `useTerminalStore` and OUTLIVE
 * this component: mounting attaches (or re-parents) the terminal's DOM
 * element into our container; unmounting detaches it without closing the
 * socket, so tab switches and panel closes keep the PTY session, its
 * scrollback, and running processes intact. Detached sessions are
 * auto-closed by the store's idle reaper after 15 minutes without input.
 *
 * The terminal runs **on the backend host**. When the app is connected
 * to an external/LAN server this is a shell on that machine, not the
 * local device — the exit/error copy and server-side folder picker make that explicit.
 *
 * Theme: follows the app's resolved light/dark theme live via
 * `useThemePreference`; the store swaps every session's palette so hidden
 * terminals wake up already matching.
 *
 * Font: follows the user's custom terminal font (Settings → Terminal,
 * `lib/terminal-font.ts`) live — a change there dispatches
 * `oa-terminal-font-change`, which this view forwards to
 * `useTerminalStore.syncFont` so every session (including ones not
 * currently attached) picks up the new stack immediately.
 *
 * `data-swipe-ignore` opts the surface out of mobile edge-swipe so
 * xterm owns its own touches (scrollback, selection).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useIsMobile } from '@/hooks/use-mobile'
import { useThemePreference } from '@/hooks/useThemePreference'
import { mediumHapticFeedback } from '@/lib/haptics'
import {
  onTerminalFontChange,
  onTerminalFontSizeChange,
  readStoredTerminalFont,
  readStoredTerminalFontSize,
} from '@/lib/terminal-font'
import { getTerminalRuntime, useTerminalStore } from '@/stores/useTerminalStore'
import { TerminalActionSheet } from './TerminalActionSheet'
import { TerminalKeyBar } from './TerminalKeyBar'
import { useLongPressSurface } from './use-long-press-surface'

export type { TerminalSessionStatus as TerminalStatus } from '@/stores/useTerminalStore'

interface TerminalViewProps {
  /** Store session id — obtained from `useTerminalStore.getState().open(...)`. */
  sessionId: string
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const meta = useTerminalStore((s) => s.sessions[sessionId])
  const status = meta?.status ?? 'error'
  const handleReady = meta?.handleReady ?? false
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const ctrlArmedRef = useRef(false)
  const isMobile = useIsMobile()
  const { resolved } = useThemePreference()
  const [actionSheetOpen, setActionSheetOpen] = useState(false)

  const setCtrl = useCallback((armed: boolean) => {
    ctrlArmedRef.current = armed
    setCtrlArmed(armed)
  }, [])

  // Keep every live terminal's palette in sync with the app theme.
  useEffect(() => {
    useTerminalStore.getState().syncTheme(resolved)
  }, [resolved])

  // Keep every live terminal's font and size in sync with Settings → Terminal
  useEffect(() => {
    useTerminalStore.getState().syncFont(readStoredTerminalFont())
    useTerminalStore.getState().syncFontSize(readStoredTerminalFontSize())
    const unbindFont = onTerminalFontChange(() => {
      useTerminalStore.getState().syncFont(readStoredTerminalFont())
    })
    const unbindSize = onTerminalFontSizeChange(() => {
      useTerminalStore.getState().syncFontSize(readStoredTerminalFontSize())
    })
    return () => {
      unbindFont()
      unbindSize()
    }
  }, [])

  // Sticky-Ctrl transform: single character → control code.
  // Handles a–z (0x01–0x1a), plus [, \, ], ^, _, ?, @.
  // Registered on the store so it applies to keystrokes from xterm's own
  // onData wiring, not just the mobile key bar.
  useEffect(() => {
    useTerminalStore.getState().setInputTransform(sessionId, (data: string): string => {
      if (!ctrlArmedRef.current || data.length !== 1) return data
      setCtrl(false)
      const ch = data.toLowerCase()
      const code = ch.charCodeAt(0)
      if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
      if (ch === '[') return '\x1b'
      if (ch === '\\') return '\x1c'
      if (ch === ']') return '\x1d'
      if (ch === '^') return '\x1e'
      if (ch === '_') return '\x1f'
      if (ch === '?') return '\x7f'
      if (ch === '@' || ch === '0') return '\x00'
      return data
    })
    return () => {
      useTerminalStore.getState().setInputTransform(sessionId, (d) => d)
    }
  }, [sessionId, setCtrl])

  // Attach: re-parent the store-owned xterm DOM into our container.
  // Detach on unmount WITHOUT disposing — the session lives on.
  useEffect(() => {
    const el = containerRef.current
    const rt = getTerminalRuntime(sessionId)
    if (!el || !rt?.handle) return

    const { term, fit } = rt.handle
    if (term.element) {
      // Previously opened elsewhere — re-parent the existing DOM.
      el.appendChild(term.element)
    } else {
      term.open(el)
    }
    rt.handle.enableWebgl?.()
    useTerminalStore.getState().setAttached(sessionId, true)

    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    const refit = () => {
      try {
        fit.fit()
        // Debounce sending the WebSocket SIGWINCH resize event slightly so continuous
        // dragging or window resizing doesn't flood the backend PTY.
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          resizeTimer = null
          try {
            useTerminalStore.getState().sendResize(sessionId, term.rows, term.cols)
          } catch {
            // session mid-teardown
          }
        }, 60)
      } catch {
        // container mid-unmount — ignore
      }
    }
    refit()
    term.focus()

    const resizeObserver = new ResizeObserver(refit)
    resizeObserver.observe(el)
    // A mobile soft keyboard only changes visualViewport. Its height update
    // normally reaches this element through ResizeObserver, but that can lag
    // behind xterm's measurement in WKWebView. Refit in the same viewport
    // event so the terminal never keeps rows hidden behind the keyboard.
    const visualViewport = isMobile ? window.visualViewport : undefined
    visualViewport?.addEventListener('resize', refit)

    return () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      visualViewport?.removeEventListener('resize', refit)
      resizeObserver.disconnect()
      useTerminalStore.getState().setAttached(sessionId, false)
      rt.handle?.disableWebgl?.()
      // Detach the DOM so the next mount can re-parent it cleanly.
      if (term.element && term.element.parentElement === el) {
        el.removeChild(term.element)
      }
    }
    // `status` in deps: after a reconnect the store may have built a fresh
    // xterm handle (idle-close disposes the old one), so re-attach on every
    // lifecycle change. Re-parenting an unchanged handle is a cheap no-op.
    // `handleReady` in deps: the xterm chunk loads on demand, so the first
    // mount usually runs before any handle exists and bails at the guard
    // above. This flag is what brings the effect back once it does.
  }, [handleReady, isMobile, sessionId, status])

  const sendKey = useCallback(
    (data: string) => {
      useTerminalStore.getState().sendInput(sessionId, data)
      getTerminalRuntime(sessionId)?.handle?.term.focus()
    },
    [sessionId],
  )

  const reconnect = useCallback(() => {
    useTerminalStore.getState().reconnect(sessionId)
  }, [sessionId])

  // Mobile long-press on the terminal surface itself: Select All / Copy /
  // Paste. xterm's own touch handling covers scroll + drag-to-select, but
  // there's no native context menu on touch, so this fills the gap the
  // same way TerminalKeyBar fills the missing soft-keyboard keys.
  const surfaceLongPress = useLongPressSurface(isMobile, () => {
    mediumHapticFeedback()
    setActionSheetOpen(true)
  })

  const selectAll = useCallback(() => {
    getTerminalRuntime(sessionId)?.handle?.term.selectAll()
    setActionSheetOpen(false)
  }, [sessionId])

  const hasSelection = getTerminalRuntime(sessionId)?.handle?.term.hasSelection() ?? false

  const copySelection = useCallback(async () => {
    const term = getTerminalRuntime(sessionId)?.handle?.term
    if (!term?.hasSelection()) return
    try {
      await navigator.clipboard.writeText(term.getSelection())
    } catch {
      // Clipboard permission denied — nothing to do.
    }
    setActionSheetOpen(false)
  }, [sessionId])

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sendKey(text)
    } catch {
      // Clipboard permission denied — nothing to do.
    }
    setActionSheetOpen(false)
  }, [sendKey])

  return (
    <div className="flex h-full flex-col" data-swipe-ignore>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-(--color-surface) p-2">
        <div
          ref={containerRef}
          data-testid="terminal-surface"
          className="h-full w-full"
          {...surfaceLongPress}
        />
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-(--color-text-muted)">
            Connecting…
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs font-semibold text-(--color-text)">Terminal unavailable</p>
            {meta?.errorMsg && (
              <p className="text-xs text-(--color-text-muted)">{meta.errorMsg}</p>
            )}
            <ReconnectButton onClick={reconnect} />
          </div>
        )}
        {status === 'exited' && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-(--color-surface)/90 px-3 py-2 text-center text-xs text-(--color-text-muted)">
            {meta?.closedReason === 'idle'
              ? 'Session ended — closed after 15 min idle'
              : 'Session ended'}
            <ReconnectButton onClick={reconnect} />
          </div>
        )}
      </div>
      {isMobile && status === 'connected' && (
        <TerminalKeyBar
          onKey={sendKey}
          ctrlArmed={ctrlArmed}
          onCtrlToggle={() => setCtrl(!ctrlArmedRef.current)}
        />
      )}

      <TerminalActionSheet
        open={actionSheetOpen}
        onOpenChange={setActionSheetOpen}
        hasSelection={hasSelection}
        onSelectAll={selectAll}
        onCopy={() => void copySelection()}
        onPaste={() => void pasteClipboard()}
      />
    </div>
  )
}

function ReconnectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-8 rounded-sm border border-(--color-border) px-3 py-1 text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) active:bg-(--bg-key)"
    >
      Reconnect
    </button>
  )
}

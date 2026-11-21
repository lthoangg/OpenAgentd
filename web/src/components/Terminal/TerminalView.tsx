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
 * Font: a fixed Nerd Font stack at the app's Text size (`lib/terminal-font.ts`).
 * A pinch on touch sets a size of its own on this device (`terminalFontPx`).
 *
 * `data-swipe-ignore` opts the surface out of mobile edge-swipe so
 * the terminal owns its touches. xterm.js 6 handles none, so
 * `useTerminalTouch` does: drag scrolls, hold opens the menu, hold and drag
 * sends arrows, double tap sends Tab, pinch sizes the text. xterm selects
 * only with a mouse, so the menu's Select Text opens the output as plain
 * text (`TerminalTextView`) for the platform's own selection.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { MessageSquarePlus } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useKeyboardOpen } from '@/hooks/use-keyboard-open'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { getPlatform } from '@/hooks/use-platform'
import { useThemePreference } from '@/hooks/useThemePreference'
import { lazySurface } from '@/lib/lazy-surface'
import { cn } from '@/lib/utils'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { getTerminalRuntime, terminalClosedMessage, useTerminalStore } from '@/stores/useTerminalStore'
import { closedReasonOf, shellErrorOf } from '@/stores/terminal-state'
import { TERMINAL_FONT_FAMILY, terminalFontSize } from '@/lib/terminal-font'
import { TerminalActionSheet } from './TerminalActionSheet'
import { readCommandFieldOn, TerminalCommandField, writeCommandFieldOn } from './TerminalCommandField'
import { TerminalContextMenu } from './TerminalContextMenu'
import { addToChatShortcutLabel } from './terminal-keys'
import { TerminalKeyBar } from './TerminalKeyBar'
import { TerminalMoreSheet } from './TerminalMoreSheet'
import { TerminalTextView } from './TerminalTextView'
import { addTerminalSelectionToChat, copyTerminalSelection, pasteIntoTerminal } from './terminal-actions'
import type { TerminalMenuAction } from './terminal-menu'
import { stickyModifierTransform, type StickyModifiers } from './terminal-modifiers'
import { terminalBufferText, type TerminalText } from './terminal-text'
import { useTerminalAutoFocus } from './use-terminal-autofocus'
import { useTerminalTouch } from './use-terminal-touch'

export type { TerminalSessionStatus as TerminalStatus } from '@/stores/useTerminalStore'

// Opened on demand (⌘F), so it stays out of the startup bundle.
const TerminalFindBar = lazySurface(() => import('./TerminalFindBar'), 'TerminalFindBar')

interface TerminalViewProps {
  /** Store session id — obtained from `useTerminalStore.getState().open(...)`. */
  sessionId: string
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const meta = useTerminalStore((s) => s.sessions[sessionId])
  const status = meta?.shellState.kind ?? 'error'
  const handleReady = meta?.handleReady ?? false
  const [modifiers, setModifiersState] = useState<StickyModifiers>({ ctrl: false, alt: false })
  const modifiersRef = useRef<StickyModifiers>({ ctrl: false, alt: false })
  const isMobile = useIsMobile()
  const touchFirst = useTouchFirst()
  const keyboardOpen = useKeyboardOpen()
  const [focusWithin, setFocusWithin] = useState(false)
  const [commandFieldOn, setCommandFieldOn] = useState(readCommandFieldOn)
  const commandFieldRef = useRef<HTMLInputElement>(null)
  const { resolved } = useThemePreference()
  const textSize = useDisplayPrefsStore((s) => s.textSize)
  const terminalFontPx = useDisplayPrefsStore((s) => s.terminalFontPx)
  const [actionSheetOpen, setActionSheetOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // The keyboard was up when More opened: a key from it gives it back.
  const moreWithKeyboardRef = useRef(false)
  const [contextMenuAt, setContextMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [textSnapshot, setTextSnapshot] = useState<TerminalText | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findSeed, setFindSeed] = useState('')
  const [findSignal, setFindSignal] = useState(0)
  const [hasSelection, setHasSelection] = useState(false)
  const workspace = meta?.contextKey ?? null

  const setModifiers = useCallback((next: StickyModifiers) => {
    modifiersRef.current = next
    setModifiersState(next)
  }, [])

  // Keep every live terminal's palette in sync with the app theme.
  useEffect(() => {
    useTerminalStore.getState().syncTheme(resolved)
  }, [resolved])

  // The terminal reads at the app's Text size, live, unless a pinch set its own.
  useEffect(() => {
    useTerminalStore.getState().syncFontSize(terminalFontPx ?? terminalFontSize(textSize))
  }, [terminalFontPx, textSize])

  // Sticky Ctrl/Alt (terminal-modifiers.ts): the next key is sent with them,
  // then they release. Registered on the store so it applies to keystrokes
  // from xterm's own onData wiring and to the key bar's keys alike.
  useEffect(() => {
    useTerminalStore.getState().setInputTransform(sessionId, stickyModifierTransform(
      () => modifiersRef.current,
      () => setModifiers({ ctrl: false, alt: false }),
    ))
    return () => {
      useTerminalStore.getState().setInputTransform(sessionId, (d) => d)
    }
  }, [sessionId, setModifiers])

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

  // Focus follows the user opening the terminal, not its status flipping
  // (busy, connected, reconnecting) while they type in the composer.
  useTerminalAutoFocus(getTerminalRuntime(sessionId)?.handle?.term, containerRef)

  const openFind = useCallback(() => {
    const term = getTerminalRuntime(sessionId)?.handle?.term
    const selected = term?.hasSelection() ? term.getSelection() : ''
    // A one-line selection seeds the query, as in an editor.
    setFindSeed(selected !== '' && selected.length <= 200 && !selected.includes('\n') ? selected : '')
    setFindOpen(true)
    setFindSignal((n) => n + 1)
  }, [sessionId])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    getTerminalRuntime(sessionId)?.handle?.term.focus()
  }, [sessionId])

  // Terminal-side events: the find chord, selection changes (for the Add to
  // chat button), and ⌘/Ctrl+click on a file path.
  useEffect(() => {
    const handle = getTerminalRuntime(sessionId)?.handle
    if (!handle) return
    const offFind = handle.onFindRequest?.(openFind)
    const selection = handle.term.onSelectionChange(() => setHasSelection(handle.term.hasSelection()))
    // Loaded on the first click: file links are never on the startup path.
    handle.setFileOpener?.((ref, cwd) => {
      void import('./terminal-file-open').then((module) => module.openTerminalFileLink(ref, cwd, workspace))
    })
    setHasSelection(handle.term.hasSelection())
    return () => {
      offFind?.()
      selection.dispose()
      handle.setFileOpener?.(null)
    }
  }, [handleReady, openFind, sessionId, status, workspace])

  const sendKey = useCallback(
    (data: string) => {
      useTerminalStore.getState().sendInput(sessionId, data)
      // Typing in the command field: the key goes to the shell (^C, history
      // arrows) but the field keeps the keyboard.
      if (document.activeElement !== commandFieldRef.current) getTerminalRuntime(sessionId)?.handle?.term.focus()
    },
    [sessionId],
  )

  const submitLine = useCallback((line: string) => {
    const term = getTerminalRuntime(sessionId)?.handle?.term
    if (!term) return
    // xterm's paste, as Run in terminal: bracketed, through the same input path.
    if (line !== '') term.paste(line)
    useTerminalStore.getState().sendInput(sessionId, '\r')
  }, [sessionId])

  const toggleCommandField = useCallback(() => {
    const next = !commandFieldOn
    setCommandFieldOn(next)
    writeCommandFieldOn(next)
    // The keyboard follows: into the new field, or back to the terminal.
    if (next) requestAnimationFrame(() => commandFieldRef.current?.focus())
    else getTerminalRuntime(sessionId)?.handle?.term.focus()
  }, [commandFieldOn, sessionId])

  /** Bring the soft keyboard up: into the command field when it is on. */
  const showKeyboard = useCallback(() => {
    if (commandFieldOn && commandFieldRef.current) commandFieldRef.current.focus()
    else getTerminalRuntime(sessionId)?.handle?.term.focus()
  }, [commandFieldOn, sessionId])

  const hideKeyboard = useCallback(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur()
  }, [])

  const openMore = useCallback(() => {
    moreWithKeyboardRef.current = keyboardOpen
    setMoreOpen(true)
  }, [keyboardOpen])

  const sendFromMore = useCallback((data: string) => {
    useTerminalStore.getState().sendInput(sessionId, data)
    if (moreWithKeyboardRef.current) showKeyboard()
  }, [sessionId, showKeyboard])

  const toggleAltFromMore = useCallback(() => {
    setModifiers({ ...modifiersRef.current, alt: !modifiersRef.current.alt })
    if (moreWithKeyboardRef.current) showKeyboard()
  }, [setModifiers, showKeyboard])

  const reconnect = useCallback(() => {
    useTerminalStore.getState().reconnect(sessionId)
  }, [sessionId])

  // Touch gestures on the surface, on a phone and on a tablet however wide
  // (a mouse never counts): the long press opens the terminal menu.
  const touchMenu = isMobile || touchFirst
  const openMenu = useCallback(() => setActionSheetOpen(true), [])
  useTerminalTouch({ enabled: touchMenu, sessionId, surfaceRef: containerRef, onMenu: openMenu })

  const addToChat = useCallback(() => {
    const term = getTerminalRuntime(sessionId)?.handle?.term
    if (term && addTerminalSelectionToChat(term)) term.clearSelection()
  }, [sessionId])

  // One handler for both forms of the menu (touch sheet, pointer menu).
  const runMenuAction = useCallback((action: TerminalMenuAction) => {
    const term = getTerminalRuntime(sessionId)?.handle?.term
    if (!term) return
    switch (action) {
      case 'select-text':
        setTextSnapshot(terminalBufferText(term.buffer.active))
        // Put the soft keyboard away: selecting needs the whole screen.
        term.blur()
        break
      case 'copy':
        void copyTerminalSelection(term)
        break
      case 'paste':
        // term.paste, not raw input: it honours bracketed-paste mode.
        void pasteIntoTerminal(term).then((pasted) => {
          if (pasted) term.focus()
        })
        break
      case 'select-all':
        term.selectAll()
        break
      case 'find':
        // After the menu has closed, so it does not take the focus back.
        window.setTimeout(openFind, 0)
        break
      case 'add-to-chat':
        addToChat()
        break
      case 'clear':
        useTerminalStore.getState().clear(sessionId)
        break
    }
  }, [addToChat, openFind, sessionId])

  const closeTextView = useCallback(() => setTextSnapshot(null), [])

  const search = getTerminalRuntime(sessionId)?.handle?.search
  // A phone always has the key bar; a tablet while its soft keyboard is up
  // for this terminal (with a hardware keyboard the soft one stays down).
  const showKeyBar = status === 'connected' && (isMobile || (touchFirst && keyboardOpen && focusWithin))

  return (
    <div
      ref={rootRef}
      className="flex h-full flex-col"
      data-swipe-ignore
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
      }}
    >
      {/* A phone keeps every column it can: 4px around the text, not 8. */}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden bg-(--color-surface)', isMobile ? 'p-1' : 'p-2')}>
        <div
          ref={containerRef}
          data-testid="terminal-surface"
          // Touch: the gestures are ours (no webview scroll or zoom), and a
          // hold opens our menu, not the webview's text selection and callout.
          className={cn('h-full w-full', touchMenu && 'touch-none select-none [-webkit-touch-callout:none]')}
          onContextMenu={(event) => {
            // Touch: the long press opens the sheet (useTerminalTouch). A
            // pointer: the terminal's menu, not the webview's menu for
            // xterm's hidden input.
            event.preventDefault()
            if (!touchMenu) setContextMenuAt({ x: event.clientX, y: event.clientY })
          }}
        />
        {textSnapshot && (
          <TerminalTextView
            text={textSnapshot}
            fontFamily={TERMINAL_FONT_FAMILY}
            fontSize={getTerminalRuntime(sessionId)?.handle?.term.options.fontSize ?? 13}
            onClose={closeTextView}
          />
        )}
        {((findOpen && search) || (!isMobile && !findOpen && hasSelection)) && (
          <div className={cn('absolute z-20 flex flex-col items-end gap-1', isMobile ? 'inset-x-1 top-1' : 'right-4 top-2')}>
            {findOpen && search && (
              <TerminalFindBar
                search={search}
                theme={resolved}
                onClose={closeFind}
                initialQuery={findSeed}
                focusSignal={findSignal}
                wide={isMobile}
              />
            )}
            {!isMobile && !findOpen && hasSelection && (
              <Button
                type="button"
                size="sm"
                className="gap-1.5 bg-(--bg-card) shadow-(--shadow-depth)"
                title={`Add selection to chat (${addToChatShortcutLabel(getPlatform().os)})`}
                // Keep the terminal's selection and focus while pressing.
                onMouseDown={(event) => event.preventDefault()}
                onClick={addToChat}
              >
                <MessageSquarePlus size={14} aria-hidden="true" />
                Add to chat
              </Button>
            )}
          </div>
        )}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-(--color-text-muted)">
            Connecting…
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs font-semibold text-(--color-text)">Terminal unavailable</p>
            {shellErrorOf(meta) && (
              <p className="text-xs text-(--color-text-muted)">{shellErrorOf(meta)}</p>
            )}
            <ReconnectButton onClick={reconnect} />
          </div>
        )}
        {status === 'exited' && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-(--color-surface)/90 px-3 py-2 text-center text-xs text-(--color-text-muted)">
            {terminalClosedMessage(closedReasonOf(meta))}
            <ReconnectButton onClick={reconnect} />
          </div>
        )}
      </div>
      {showKeyBar && commandFieldOn && <TerminalCommandField onSubmit={submitLine} inputRef={commandFieldRef} />}
      {showKeyBar && (
        <TerminalKeyBar
          onKey={sendKey}
          ctrlArmed={modifiers.ctrl}
          onCtrlToggle={() => setModifiers({ ...modifiersRef.current, ctrl: !modifiersRef.current.ctrl })}
          // A tablet shows the bar only while its keyboard is up.
          typing={keyboardOpen || !isMobile}
          lineOn={commandFieldOn}
          onLineToggle={toggleCommandField}
          onShowKeyboard={showKeyboard}
          onHideKeyboard={hideKeyboard}
          onMore={openMore}
        />
      )}

      <TerminalActionSheet
        open={actionSheetOpen}
        onClose={() => setActionSheetOpen(false)}
        onAction={runMenuAction}
      />
      <TerminalMoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        onKey={sendFromMore}
        altArmed={modifiers.alt}
        onAltToggle={toggleAltFromMore}
        fontPx={terminalFontPx}
        onResetFont={() => useDisplayPrefsStore.getState().setTerminalFontPx(null)}
      />
      {contextMenuAt && (
        <TerminalContextMenu
          at={contextMenuAt}
          onDismiss={() => setContextMenuAt(null)}
          hasSelection={getTerminalRuntime(sessionId)?.handle?.term.hasSelection() ?? hasSelection}
          os={getPlatform().os}
          onAction={runMenuAction}
        />
      )}
    </div>
  )
}

function ReconnectButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" size="sm" onClick={onClick}>
      Reconnect
    </Button>
  )
}

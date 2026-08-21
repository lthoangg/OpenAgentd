import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { GripHorizontal } from 'lucide-react'
import { InputComposer, type FileRef, type InputComposerHandle, type SlashCommand, type SnippetCommand } from './InputComposer'
import { RevertNotice } from './RevertNotice'
import { useIsMobile } from '@/hooks/use-mobile'
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'
import type { AgentCapabilities } from '@/api/types'

// ── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'oa-input-position'

/** Persisted drag offset relative to the default docked position. */
interface StoredOffset {
  x: number
  y: number
}

function loadOffset(): StoredOffset {
  if (typeof window === 'undefined') return { x: 0, y: 0 }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { x: 0, y: 0 }
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'x' in parsed &&
      'y' in parsed &&
      typeof (parsed as StoredOffset).x === 'number' &&
      typeof (parsed as StoredOffset).y === 'number'
    ) {
      return { x: (parsed as StoredOffset).x, y: (parsed as StoredOffset).y }
    }
  } catch {
    // ignore malformed localStorage
  }
  return { x: 0, y: 0 }
}

function saveOffset(offset: StoredOffset): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset))
  } catch {
    // ignore quota errors
  }
}

// ── Bounds clamping ──────────────────────────────────────────────────────────

interface Size {
  width: number
  height: number
}

/**
 * Clamp an offset so the floating panel stays fully inside `bounds`.
 *
 * The panel's default position is bottom-centered with a 16px gap. Offsets
 * are measured relative to that docked position (x: horizontal drift,
 * y: upward drift is negative).
 *
 * Results are rounded to whole pixels. The offset is applied as a
 * ``transform`` translation, which is *not* pixel-snapped by the compositor,
 * so a fractional value (drag deltas and the halved clamp ranges below both
 * produce them) leaves every glyph in the composer rasterised half a pixel
 * off the device grid and visibly softer than the chat column beside it.
 */
function clampOffset(offset: StoredOffset, panel: Size, bounds: Size): StoredOffset {
  const GAP = 16
  const DRAG_HANDLE_CLEARANCE = 10
  // Horizontal: centered → allowed range is ±(bounds.width - panel.width) / 2
  const maxX = Math.max(0, (bounds.width - panel.width) / 2 - GAP)
  // Vertical: docked at bottom. y is typically negative (dragged up).
  // The drag handle sits ~10px above the panel, so keep that much visible
  // when the bar is pinned to the top instead of letting the whole control
  // disappear behind the app header/chrome.
  //   minY = -(bounds.height - panel.height - GAP - handleClearance)
  //   maxY = 0 → at default docked position
  const minY = -Math.max(0, bounds.height - panel.height - GAP - DRAG_HANDLE_CLEARANCE)
  return {
    x: Math.round(Math.min(maxX, Math.max(-maxX, offset.x))),
    y: Math.round(Math.min(0, Math.max(minY, offset.y))),
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface FloatingInputComposerProps {
  boundsRef: React.RefObject<HTMLElement | null>
  onSubmit: (message: string, files?: File[], mentions?: string[]) => void
  onStop?: () => void
  onSlashCommand?: (id: string) => void
  onSnippetCommand?: (id: string) => Promise<string | null> | string | null
  slashCommands?: SlashCommand[]
  snippetCommands?: SnippetCommand[]
  fileRefs?: FileRef[]
  onFileRefsNeeded?: () => void
  isStreaming?: boolean
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  capabilities?: AgentCapabilities
  revertedCount?: number
  revertedMessages?: Array<{ role: string; content: string }>
  onRedo?: () => void
  onRedoAll?: () => void
  historyPrompts?: string[]
  value?: string
  onValueChange?: (value: string) => void
}

/**
 * Floating input bar — two modes:
 *
 * Mobile: a static docked bar pinned to the bottom of the viewport with
 * `safe-area-inset-bottom` clearance. No drag, no position memory.
 *
 * Desktop: draggable absolutely-positioned panel. Drag is gated to an
 * explicit grip handle so it doesn't conflict with textarea text selection.
 * Position persists in `localStorage` and is clamped on resize.
 */
export const FloatingInputComposer = memo(
  forwardRef<InputComposerHandle, FloatingInputComposerProps>(
    function FloatingInputComposer({ boundsRef, ...inputProps }, ref) {
    const isMobile = useIsMobile()
    const dragControls = useDragControls()
    const panelRef = useRef<HTMLDivElement>(null)
    const [offset, setOffset] = useState<StoredOffset>(() => loadOffset())
    const [renderSuggestionsBelow, setRenderSuggestionsBelow] = useState(false)
    const [suggestionsOpen, setSuggestionsOpen] = useState(false)

    // ── Minimize-on-blur (desktop only) ──────────────────────────────────
    // The bar collapses to the slim action strip after the
    // textarea loses focus while empty, so a blurred composer doesn't
    // dominate the chat surface. It expands again on focus or whenever
    // there's any meaningful content (text, attachments, queued messages).
    // Streaming alone does not force it open; users can move focus elsewhere
    // and keep only the stop/restore affordances visible. Mobile keeps the
    // full bar — the soft keyboard already dictates its own focus/blur
    // cadence and a collapse there would fight system behavior.
    // Start collapsed — the slim action strip is the
    // resting state. The user summons the full pill explicitly via
    // click, focus, Ctrl/⌘+I, or by attaching a file. This matches
    // the minimal-chrome aesthetic of the design and prevents an
    // empty composer from dominating the chat surface on load.
    const [minimized, setMinimized] = useState(true)
    const [hasContent, setHasContent] = useState(false)
    const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const innerRef = useRef<InputComposerHandle | null>(null)
    const setInputRefs = useCallback((handle: InputComposerHandle | null) => {
      innerRef.current = handle
    }, [])

    const expand = useCallback(() => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
      setMinimized(false)
      // Focus is owned by InputComposer's auto-focus-on-mount callback ref
      // — it fires the moment the textarea actually attaches to the
      // DOM, after AnimatePresence finishes the message-button exit.
      // A parent-side focus() here would race the unmounted ref.
    }, [])

    useImperativeHandle(ref, () => ({
      focus: () => {
        expand()
        requestAnimationFrame(() => innerRef.current?.focus())
      },
      setValue: (text: string) => {
        // Only expand when setting real content — clearing the composer
        // (e.g. on session switch) should not force the bar open.
        if (text) expand()
        innerRef.current?.setValue(text)
      },
      appendValue: (text: string) => {
        if (text) expand()
        innerRef.current?.appendValue(text)
      },
      insertText: (text: string) => {
        if (text) expand()
        innerRef.current?.insertText(text)
      },
      setFiles: (files: File[]) => {
        if (files.length > 0) expand()
        innerRef.current?.setFiles(files)
      },
      addFiles: (files: File[]) => {
        if (files.length > 0) expand()
        innerRef.current?.addFiles(files)
      },
      restoreLastSubmission: () => {
        // Expand first: a failed send leaves the bar minimized, and silently
        // refilling a collapsed composer would look like the message vanished.
        expand()
        innerRef.current?.restoreLastSubmission()
      },
    }), [expand])

    const handleFocus = useCallback(() => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
      setMinimized(false)
    }, [])

    const minimize = useCallback(() => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
      setMinimized(true)
    }, [])

    // Keep a stable ref to isMobile so the blur timer callback always reads
    // the *current* value, not the value captured when handleBlur was created.
    // This prevents orientation-change state drift: if the viewport widens
    // from portrait mobile (isMobile=true) to tablet landscape (isMobile=false)
    // while the timer is pending, the timer must not collapse the bar.
    const isMobileRef = useRef(isMobile)
    useEffect(() => { isMobileRef.current = isMobile }, [isMobile])

    const handleBlur = useCallback((canMinimize: boolean) => {
      if (!canMinimize) return
      // Never minimize on mobile — the bar is always fully visible there.
      // Checking the ref (not the closure value) guards against the case where
      // isMobile changes between the blur event and the 180ms timer firing
      // (e.g. a tablet orientation flip from portrait → landscape).
      if (isMobileRef.current) return
      // Short delay so a click on a sibling control inside the bar
      // (e.g. the attach picker, mic) doesn't trigger a collapse mid-action.
      blurTimerRef.current = setTimeout(() => {
        setMinimized(true)
        blurTimerRef.current = null
      }, 180)
    }, [])

    const onSubmitRef = useRef(inputProps.onSubmit)
    useEffect(() => { onSubmitRef.current = inputProps.onSubmit })
    const handleSubmit = useCallback((message: string, files?: File[], mentions?: string[]) => {
      onSubmitRef.current(message, files, mentions)
      // Only collapse on desktop — on mobile the bar is always fully visible
      // and calling minimize() here drifts the `minimized` state flag to
      // `true`, which causes the bar to snap collapsed if the viewport later
      // crosses the breakpoint (e.g. tablet orientation change).
      if (!isMobile) minimize()
    }, [isMobile, minimize])

    useEffect(() => () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }, [])

    // ── Global summon shortcut: ⌘I on macOS, Ctrl+I elsewhere ────────
     // Brings the composer back to the foreground from any focus
     // context. If the bar is collapsed it expands; either way the
     // textarea takes focus so the user can immediately start typing.
     // Mobile is excluded — the soft keyboard owns focus there and a
     // window-level shortcut would never fire from a virtual keyboard.
     useEffect(() => {
       if (isMobile) return
       const { os } = getPlatform()
       const onKeyDown = (e: KeyboardEvent) => {
         const target = e.target
         const isComposerTarget = target instanceof Node && panelRef.current?.contains(target)
         if (e.key === 'Escape' && isComposerTarget) {
           e.preventDefault()
           minimize()
           return
         }
         // ``e.key`` is the printed character so the check is layout
         // safe; we accept upper- and lower-case to cover Caps Lock.
         if ((e.key === 'i' || e.key === 'I') && isPrimaryShortcut(e, os)) {
           // Don't fight with browser-native Ctrl/⌘+I in editable
           // surfaces *outside* our composer (e.g. a Markdown editor
           // mounted somewhere on the page). The composer's textarea
           // doesn't use italics so summoning while focus is already
           // there is harmless and just refocuses.
           e.preventDefault()
           expand()
         }
       }
       window.addEventListener('keydown', onKeyDown)
       return () => window.removeEventListener('keydown', onKeyDown)
     }, [isMobile, expand, minimize])

    // ── Global paste: expand + forward when bar is minimized ─────────────
    // When the floating bar is collapsed (minimized) and the user hits
    // Cmd+V / Ctrl+V (or triggers a paste from anywhere on the page that
    // isn't already an editable target), we intercept the paste, expand
    // the composer, and forward the clipboard contents — text or files —
    // so the user never has to click the bar first just to paste.
    //
    // We only intercept when:
    //   1. The bar is currently in the minimized state (effectiveMinimized).
    //   2. The paste target is NOT already an editable element (input,
    //      textarea, contenteditable) — those should keep their own paste
    //      behaviour unaffected.
    //   3. Desktop only (mobile is always expanded and handles paste natively).
    const effectiveMinimizedRef = useRef(false)
    // Keep a ref to effectiveMinimized computed below so the paste handler
    // always reads the current value without being re-registered each render.
    // We'll update it via useEffect after the value is calculated.
    useEffect(() => {
      if (isMobile) return
      const onPaste = (e: ClipboardEvent) => {
        if (!effectiveMinimizedRef.current) return

        const target = e.target as HTMLElement | null
        // Don't intercept paste inside native editable elements.
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable
        ) {
          return
        }

        // We're about to handle this paste — prevent browser default so
        // we don't simultaneously insert into whatever currently has focus.
        e.preventDefault()

        const cd = e.clipboardData
        if (!cd) return

        // Collect file items first (images, etc.).
        const pastedFiles: File[] = []
        for (const item of Array.from(cd.items)) {
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) pastedFiles.push(file)
          }
        }

        if (pastedFiles.length > 0) {
          expand()
          requestAnimationFrame(() => {
            innerRef.current?.addFiles(pastedFiles)
            innerRef.current?.focus()
          })
          return
        }

        // Fall back to plain text.
        const text = cd.getData('text/plain')
        if (text) {
          expand()
          requestAnimationFrame(() => {
            innerRef.current?.appendValue(text)
            innerRef.current?.focus()
          })
        }
      }

      window.addEventListener('paste', onPaste)
      return () => window.removeEventListener('paste', onPaste)
    }, [isMobile, expand])

    // External signals that should keep the bar expanded regardless of
    // focus state. ``disabled`` covers the "waiting for response" pause; ``hasContent`` covers
    // text/attachments held inside InputComposer so
    // dropping a file via the slim strip's attach button immediately
    // re-expands the bar. Derived (not stored) so we don't cascade
    // renders inside an effect.
    const forceExpanded =
      inputProps.disabled === true ||
      (inputProps.revertedCount ?? 0) > 0 ||
      hasContent

    const handleHasContentChange = useCallback((next: boolean) => {
      setHasContent(next)
      // When content arrives while minimized, also cancel any pending
      // collapse so the bar settles into the expanded state cleanly.
      if (next && blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
    }, [])

    useEffect(() => {
      if (isMobile || forceExpanded) return

      const syncMinimizedWithFocus = () => {
        const active = document.activeElement
        const containsFocus = active instanceof Node && panelRef.current?.contains(active)
        if (!containsFocus) setMinimized(true)
      }

      syncMinimizedWithFocus()
      window.addEventListener('focusin', syncMinimizedWithFocus)
      return () => window.removeEventListener('focusin', syncMinimizedWithFocus)
    }, [forceExpanded, isMobile])

    const effectiveMinimized = !isMobile && minimized && !forceExpanded

    // Keep the ref used by the paste handler in sync with the current value.
    useEffect(() => {
      effectiveMinimizedRef.current = effectiveMinimized
    }, [effectiveMinimized])

    const recomputeSuggestionPlacement = useCallback(() => {
      const bounds = boundsRef.current
      const panel = panelRef.current
      if (!bounds || !panel) return
      const b = bounds.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      const spaceAbove = p.top - b.top
      const spaceBelow = b.bottom - p.bottom
      setRenderSuggestionsBelow(spaceBelow >= spaceAbove)
    }, [boundsRef])

    useEffect(() => {
      if (isMobile || !suggestionsOpen) return
      const frame = requestAnimationFrame(recomputeSuggestionPlacement)
      return () => cancelAnimationFrame(frame)
    }, [isMobile, suggestionsOpen, offset, recomputeSuggestionPlacement])

    const clampToVisibleBounds = useCallback(() => {
      const bounds = boundsRef.current
      const panel = panelRef.current
      if (!bounds || !panel) return
      const b = bounds.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      setOffset((current) => {
        const next = clampOffset(
          current,
          { width: p.width, height: p.height },
          { width: b.width, height: b.height },
        )
        if (next.x === current.x && next.y === current.y) return current
        saveOffset(next)
        return next
      })
      recomputeSuggestionPlacement()
    }, [boundsRef, recomputeSuggestionPlacement])

    useLayoutEffect(() => {
      if (!isMobile) clampToVisibleBounds()
    }, [isMobile, effectiveMinimized, hasContent, clampToVisibleBounds])

    useEffect(() => {
      if (isMobile) return // no clamping needed on mobile
      const observedBounds = boundsRef.current
      const observedPanel = panelRef.current
      clampToVisibleBounds()
      let resizeObserver: ResizeObserver | null = null
      if (observedBounds && observedPanel && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(clampToVisibleBounds)
        resizeObserver.observe(observedBounds)
        resizeObserver.observe(observedPanel)
      }
      window.addEventListener('resize', clampToVisibleBounds)
      return () => {
        window.removeEventListener('resize', clampToVisibleBounds)
        resizeObserver?.disconnect()
      }
    }, [isMobile, boundsRef, clampToVisibleBounds])

    const handleDragEnd = useCallback(
      (_e: unknown, info: { offset: { x: number; y: number } }) => {
        const bounds = boundsRef.current
        const panel = panelRef.current
        if (!bounds || !panel) return
        const b = bounds.getBoundingClientRect()
        const p = panel.getBoundingClientRect()
        const next = clampOffset(
          { x: offset.x + info.offset.x, y: offset.y + info.offset.y },
          { width: p.width, height: p.height },
          { width: b.width, height: b.height },
        )
        setOffset(next)
        saveOffset(next)
        requestAnimationFrame(recomputeSuggestionPlacement)
      },
      [boundsRef, offset, recomputeSuggestionPlacement],
    )

    const handleReset = useCallback(() => {
      const next = { x: 0, y: 0 }
      setOffset(next)
      saveOffset(next)
      requestAnimationFrame(recomputeSuggestionPlacement)
    }, [recomputeSuggestionPlacement])

    // ── Mobile: static docked bar ────────────────────────────────────────────
    if (isMobile) {
      return (
        // border-t separates from chat content; pb-safe clears the home
        // indicator. The composer no longer chases the keyboard itself — the
        // app shell (`.mobile-viewport`) is bound to `window.visualViewport`
        // in `useMobileViewportGuards`, so it shrinks to the visible region and
        // this bottom-docked bar rides up on the keyboard via flexbox. That
        // moves the whole UI as one rigid, GPU-composited unit instead of
        // re-rendering the composer subtree every keyboard frame.
        <div
          data-testid="mobile-inputbar-container"
          // Solid opaque background (no backdrop-blur): on iOS WebKit a
          // translucent + blurred bar re-rasterises its whole backdrop on any
          // content change (e.g. attachment/action buttons mounting or
          // unmounting), which flickers. A solid fill is cheaper, flicker-free,
          // and more legible over scrolling chat content.
          className="pointer-events-auto border-t border-(--color-border) bg-(--bg-page) px-3 pb-safe pt-2"
        >
          <RevertNotice count={inputProps.revertedCount ?? 0} messages={inputProps.revertedMessages ?? []} onRedo={inputProps.onRedo} onRedoAll={inputProps.onRedoAll} />
          <InputComposer
            ref={setInputRefs}
            floating
            filesBelow={false}
            suggestionsBelow={false}
            {...inputProps}
            onValueChange={inputProps.onValueChange}
            onSuggestionsMenuChange={setSuggestionsOpen}
            onSubmit={handleSubmit}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onHasContentChange={handleHasContentChange}
          />
        </div>
      )
    }

    // ── Desktop: draggable floating panel ────────────────────────────────────
    return (
      // Centering is done by the layout engine (``inset-x-0`` + ``mx-auto``),
      // not by ``-translate-x-1/2``. A percentage transform resolves against
      // the panel's own width, so any odd width (``w-fit`` in the collapsed
      // state, or ``max-w-md`` against an odd-width pane) centres the bar on a
      // half pixel and softens all of its text. Margin-auto centring is
      // pixel-snapped. It also keeps ``transform`` exclusively framer's, per
      // the house rule in ``web/src/AGENTS.md``: stacking a static Tailwind
      // translate on the node framer animates ``x`` on means the two fight
      // over the same property.
      // ``pointer-events-none`` on this wrapper is load-bearing, not cosmetic.
      // The wrapper is the *layout* box and never moves: framer translates only
      // the inner panel, so after a drag the wrapper is left behind as an
      // invisible ``max-w-md``-wide rectangle sitting at the docked position,
      // above the transcript in the stacking order (``z-20``). Transparent
      // boxes still take hits, so it silently swallowed every click on the
      // chat content underneath. Hit-testing therefore lives on the panel that
      // actually carries the transform.
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto ${
          effectiveMinimized ? 'w-fit' : 'w-full max-w-md'
        }`}
      >
        <motion.div
          ref={panelRef}
          drag
          dragListener={false}
          dragControls={dragControls}
          dragMomentum={false}
          dragElastic={0}
          onDragEnd={handleDragEnd}
          animate={{ x: offset.x, y: offset.y }}
          // Deliberately not gated on `prefers-reduced-motion`: this settle is
          // direct-manipulation feedback for a drag the user just performed,
          // and the spring's overshoot measures 1.1% of travel (1.1px per
          // 100px, peaking at 283ms) — imperceptible, not a bounce worth
          // suppressing. Re-derive with `spring()` from framer-motion before
          // flagging this again.
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="pointer-events-auto w-full"
          style={{ touchAction: 'none' }}
        >
        <RevertNotice count={inputProps.revertedCount ?? 0} messages={inputProps.revertedMessages ?? []} onRedo={inputProps.onRedo} onRedoAll={inputProps.onRedoAll} />
        <div className={effectiveMinimized ? '' : 'px-3'}>
          <InputComposer
            ref={setInputRefs}
            floating
            filesBelow={renderSuggestionsBelow}
            suggestionsBelow={renderSuggestionsBelow}
            minimized={effectiveMinimized}
            onUnminimize={expand}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onHasContentChange={handleHasContentChange}
            onValueChange={inputProps.onValueChange}
            onSuggestionsMenuChange={setSuggestionsOpen}
            renderDragHandle={() => (
            <button
              type="button"
              aria-label="Drag input bar (double-click to reset position)"
              title="Drag to move · Double-click to reset"
              onPointerDown={(e) => dragControls.start(e)}
              onDoubleClick={handleReset}
              className="absolute left-1/2 top-0 z-10 flex h-4 w-10 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-(--color-border) bg-(--bg-key) text-(--color-text-muted) shadow-sm transition-colors hover:text-(--color-text) active:cursor-grabbing"
            >
              <GripHorizontal size={12} aria-hidden="true" />
            </button>
          )}
            {...inputProps}
            onSubmit={handleSubmit}
          />
        </div>
        </motion.div>
      </div>
    )
  },
))

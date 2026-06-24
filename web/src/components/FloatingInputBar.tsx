import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { GripHorizontal } from 'lucide-react'
import { InputBar, type FileRef, type InputBarHandle, type SlashCommand, type SnippetCommand } from './InputBar'
import { RevertNotice } from './RevertNotice'
import { useIsMobile } from '@/hooks/use-mobile'
import { useVisualKeyboardInset } from '@/hooks/use-visual-keyboard-inset'
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
 */
function clampOffset(offset: StoredOffset, panel: Size, bounds: Size): StoredOffset {
  const GAP = 16
  // Horizontal: centered → allowed range is ±(bounds.width - panel.width) / 2
  const maxX = Math.max(0, (bounds.width - panel.width) / 2 - GAP)
  // Vertical: docked at bottom. y is typically negative (dragged up).
  //   minY = -(bounds.height - panel.height - GAP) → pinned to top
  //   maxY = 0 → at default docked position
  const minY = -Math.max(0, bounds.height - panel.height - GAP)
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(0, Math.max(minY, offset.y)),
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface FloatingInputBarProps {
  boundsRef: React.RefObject<HTMLElement | null>
  onSubmit: (message: string, files?: File[]) => void
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
  voiceEnabled?: boolean
  voiceUnavailableReason?: string | null
  revertedCount?: number
  revertedMessages?: Array<{ role: string; content: string }>
  onRedo?: () => void
  historyPrompts?: string[]
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
export const FloatingInputBar = forwardRef<InputBarHandle, FloatingInputBarProps>(
  function FloatingInputBar({ boundsRef, ...inputProps }, ref) {
    const isMobile = useIsMobile()
    const keyboardInset = useVisualKeyboardInset()
    const dragControls = useDragControls()
    const panelRef = useRef<HTMLDivElement>(null)
    const [offset, setOffset] = useState<StoredOffset>(() => loadOffset())
    const [filesBelow, setFilesBelow] = useState(true)

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

    const innerRef = useRef<InputBarHandle | null>(null)
    const setInputRefs = useCallback((handle: InputBarHandle | null) => {
      innerRef.current = handle
    }, [])

    const expand = useCallback(() => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
      setMinimized(false)
      // Focus is owned by InputBar's auto-focus-on-mount callback ref
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

    const handleBlur = useCallback((canMinimize: boolean) => {
      if (!canMinimize) return
      // Short delay so a click on a sibling control inside the bar
      // (e.g. the attach picker, mic) doesn't trigger a collapse mid-action.
      blurTimerRef.current = setTimeout(() => {
        setMinimized(true)
        blurTimerRef.current = null
      }, 180)
    }, [])

    const handleSubmit = useCallback((message: string, files?: File[]) => {
      inputProps.onSubmit(message, files)
      minimize()
    }, [inputProps, minimize])

    useEffect(() => () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }, [])

    // ── Global summon shortcut: Ctrl+I (⌘I on macOS) ─────────────────
    // Brings the composer back to the foreground from any focus
    // context. If the bar is collapsed it expands; either way the
    // textarea takes focus so the user can immediately start typing.
    // Mobile is excluded — the soft keyboard owns focus there and a
    // window-level shortcut would never fire from a virtual keyboard.
    useEffect(() => {
      if (isMobile) return
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
        if (e.ctrlKey && !e.metaKey && (e.key === 'i' || e.key === 'I')) {
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

    // External signals that should keep the bar expanded regardless of
    // focus state. ``disabled`` covers the "waiting for response" pause; ``hasContent`` covers
    // text/attachments held inside InputBar so
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

    const effectiveMinimized = !isMobile && minimized && !forceExpanded

    const NEAR_BOTTOM_THRESHOLD = 140

    const recomputeFilesBelow = useCallback(() => {
      const bounds = boundsRef.current
      const panel = panelRef.current
      if (!bounds || !panel) return
      const b = bounds.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      setFilesBelow(b.bottom - p.bottom >= NEAR_BOTTOM_THRESHOLD)
    }, [boundsRef])

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
      recomputeFilesBelow()
    }, [boundsRef, recomputeFilesBelow])

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
        requestAnimationFrame(recomputeFilesBelow)
      },
      [boundsRef, offset, recomputeFilesBelow],
    )

    const handleReset = useCallback(() => {
      const next = { x: 0, y: 0 }
      setOffset(next)
      saveOffset(next)
      requestAnimationFrame(recomputeFilesBelow)
    }, [recomputeFilesBelow])

    // ── Mobile: Swipe-down to dismiss keyboard / de-focus ───────────────────
    const touchStartY = useRef<number | null>(null)
    const touchStartX = useRef<number | null>(null)

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY.current = e.touches[0].clientY
        touchStartX.current = e.touches[0].clientX
      }
    }, [])

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      if (touchStartY.current === null || touchStartX.current === null) return

      const currentY = e.touches[0].clientY
      const currentX = e.touches[0].clientX
      const diffY = currentY - touchStartY.current
      const diffX = Math.abs(currentX - touchStartX.current)

      // If the user swipes down by more than 30px, and the swipe is mostly vertical:
      if (diffY > 30 && diffY > diffX * 1.5) {
        const active = document.activeElement
        if (active instanceof HTMLElement && active.matches('input, textarea')) {
          active.blur()
        }
        touchStartY.current = null
        touchStartX.current = null
      }
    }, [])

    const handleTouchEnd = useCallback(() => {
      touchStartY.current = null
      touchStartX.current = null
    }, [])

    // ── Mobile: static docked bar ────────────────────────────────────────────
    if (isMobile) {
      return (
        // border-t separates from chat content; pb-safe clears the home
        // indicator, and the visualViewport inset lifts the composer above
        // the soft keyboard on iOS/Android Tauri shells.
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="pointer-events-auto border-t border-(--color-border) bg-(--bg-key)/20 px-3 pb-safe pt-2 backdrop-blur-xl transition-[padding-bottom] duration-150"
          style={keyboardInset > 0 ? { paddingBottom: `calc(${keyboardInset}px + 0.5rem)` } : undefined}
        >
          <RevertNotice count={inputProps.revertedCount ?? 0} messages={inputProps.revertedMessages ?? []} onRedo={inputProps.onRedo} />
          <InputBar ref={setInputRefs} floating filesBelow={false} {...inputProps} onSubmit={handleSubmit} />
        </div>
      )
    }

    // ── Desktop: draggable floating panel ────────────────────────────────────
    return (
      <motion.div
        ref={panelRef}
        drag
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        dragElastic={0}
        onDragEnd={handleDragEnd}
        animate={{ x: offset.x, y: offset.y }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        className={`pointer-events-auto absolute bottom-4 left-1/2 z-20 -translate-x-1/2 ${
          effectiveMinimized ? 'w-fit' : 'w-full max-w-md'
        }`}
        style={{ touchAction: 'none' }}
      >
        <RevertNotice count={inputProps.revertedCount ?? 0} messages={inputProps.revertedMessages ?? []} onRedo={inputProps.onRedo} />
        <div className={effectiveMinimized ? '' : 'px-3'}>
          <InputBar
            ref={setInputRefs}
            floating
            filesBelow={filesBelow}
            minimized={effectiveMinimized}
            onUnminimize={expand}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onHasContentChange={handleHasContentChange}
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
    )
  },
)

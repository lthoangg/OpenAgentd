import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { GripHorizontal } from 'lucide-react'
import { InputBar, type InputBarHandle, type SlashCommand } from './InputBar'
import { PendingMessageQueue } from './PendingMessageQueue'
import { useIsMobile } from '@/hooks/use-mobile'
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
  slashCommands?: SlashCommand[]
  isStreaming?: boolean
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  capabilities?: AgentCapabilities
  voiceEnabled?: boolean
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
    const dragControls = useDragControls()
    const panelRef = useRef<HTMLDivElement>(null)
    const [offset, setOffset] = useState<StoredOffset>(() => loadOffset())
    const [filesBelow, setFilesBelow] = useState(true)

    const NEAR_BOTTOM_THRESHOLD = 140

    const recomputeFilesBelow = useCallback(() => {
      const bounds = boundsRef.current
      const panel = panelRef.current
      if (!bounds || !panel) return
      const b = bounds.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      setFilesBelow(b.bottom - p.bottom >= NEAR_BOTTOM_THRESHOLD)
    }, [boundsRef])

    useEffect(() => {
      if (isMobile) return // no clamping needed on mobile
      const clamp = () => {
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
      }
      clamp()
      window.addEventListener('resize', clamp)
      return () => window.removeEventListener('resize', clamp)
    }, [isMobile, boundsRef, recomputeFilesBelow])

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

    // ── Mobile: static docked bar ────────────────────────────────────────────
    if (isMobile) {
      return (
        // border-t separates from chat content; pb-safe clears the home indicator
        <div className="pointer-events-auto border-t border-(--color-border) bg-(--color-surface-2)/20 px-3 pb-safe pt-2 backdrop-blur-xl">
          <PendingMessageQueue inputRef={ref as React.RefObject<InputBarHandle | null>} />
          <InputBar ref={ref} floating filesBelow={false} {...inputProps} />
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
        className="pointer-events-auto absolute bottom-4 left-1/2 z-20 w-full max-w-xl -translate-x-1/2 px-4"
        style={{ touchAction: 'none' }}
      >
        <PendingMessageQueue inputRef={ref as React.RefObject<InputBarHandle | null>} />
        <InputBar
          ref={ref}
          floating
          filesBelow={filesBelow}
          renderDragHandle={() => (
            <button
              type="button"
              aria-label="Drag input bar (double-click to reset position)"
              title="Drag to move · Double-click to reset"
              onPointerDown={(e) => dragControls.start(e)}
              onDoubleClick={handleReset}
              className="absolute left-1/2 top-0 z-10 flex h-4 w-10 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-(--color-border) bg-(--color-surface-2) text-(--color-text-muted) shadow-sm transition-colors hover:text-(--color-text) active:cursor-grabbing"
            >
              <GripHorizontal size={12} aria-hidden="true" />
            </button>
          )}
          {...inputProps}
        />
      </motion.div>
    )
  },
)

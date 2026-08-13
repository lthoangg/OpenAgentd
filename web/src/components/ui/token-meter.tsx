/**
 * TokenMeter — compact circular display of current input tokens.
 *
 * The circle keeps the header quiet while still surfacing the value that
 * drives context compaction. Hover/focus/click reveals input/output/cache
 * detail; click covers touch platforms where hover is unavailable.
 */

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'

import { cn } from '@/lib/utils'

const tokenMeterUsdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

export const DEFAULT_SUMMARY_TRIGGER_TOKENS = 250_000

export interface TokenMeterProps {
  input: number
  output: number
  cached?: number
  /** Estimated USD cost accumulated across the active session. */
  sessionCostUsd?: number
  trigger?: number
  pulsing?: boolean
  className?: string
  /** Title attribute override (defaults to a verbose tooltip). */
  title?: string
}

export function TokenMeter({
  input,
  output,
  cached = 0,
  sessionCostUsd,
  trigger = DEFAULT_SUMMARY_TRIGGER_TOKENS,
  pulsing: _pulsing = false,
  className,
  title,
}: TokenMeterProps) {
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const safeTrigger = Math.max(trigger, 1)
  const progress = Math.min(input / safeTrigger, 1)
  const percent = Math.round(progress * 100)
  const ringColor = 'var(--color-accent)'
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - progress)
  const tooltip =
    title ??
    `Input: ${input.toLocaleString()} / ${safeTrigger.toLocaleString()} (${percent}%) · Output: ${output.toLocaleString()}${
      cached > 0 ? ` · Cache: ${cached.toLocaleString()}` : ''
    }`

  const open = hoverOpen || pinnedOpen

  const updateTooltipPosition = () => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const tooltipWidth = 160
    const tooltipHeight = 112
    const gap = 8
    const left = Math.max(8, Math.min(rect.right - tooltipWidth, window.innerWidth - tooltipWidth - 8))
    const preferredTop = rect.bottom + gap
    const top = preferredTop + tooltipHeight > window.innerHeight
      ? Math.max(8, rect.top - tooltipHeight - gap)
      : preferredTop

    setTooltipPosition({ top, left })
  }

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const openHoverTooltip = () => {
    clearCloseTimer()
    updateTooltipPosition()
    setHoverOpen(true)
  }

  const closeHoverTooltip = () => {
    if (pinnedOpen) return
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      setHoverOpen(false)
      closeTimerRef.current = null
    }, 0)
  }

  useEffect(() => {
    if (!open) return

    updateTooltipPosition()
    window.addEventListener('resize', updateTooltipPosition)
    window.addEventListener('scroll', updateTooltipPosition, { passive: true, capture: true })

    return () => {
      window.removeEventListener('resize', updateTooltipPosition)
      window.removeEventListener('scroll', updateTooltipPosition, { capture: true })
    }
  }, [open])

  useEffect(() => {
    if (!pinnedOpen) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (
        triggerRef.current?.contains(target) ||
        tooltipRef.current?.contains(target)
      ) return
      setPinnedOpen(false)
      setHoverOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [pinnedOpen])

  useHotkey('Escape', () => {
    setPinnedOpen(false)
    setHoverOpen(false)
  }, { enabled: pinnedOpen })

  return (
    <div
      className={cn('group relative inline-flex items-center', className)}
      onMouseEnter={openHoverTooltip}
      onMouseLeave={closeHoverTooltip}
    >
      <button
        ref={triggerRef}
        type="button"
        className="relative flex h-9 min-w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none md:h-7 md:min-w-7 md:rounded-sm"
        aria-label={tooltip}
        aria-expanded={open}
        onClick={() => {
          clearCloseTimer()
          updateTooltipPosition()
          setPinnedOpen((value) => {
            const next = !value
            if (!next) setHoverOpen(false)
            return next
          })
        }}
        onFocus={openHoverTooltip}
        onBlur={closeHoverTooltip}
      >
        <svg className="h-[17px] w-[17px] -rotate-90" viewBox="0 0 18 18" aria-hidden="true">
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeOpacity="0.18"
            strokeWidth="2"
          />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeLinecap="round"
            strokeWidth="2.6"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
      </button>
      {open && tooltipPosition && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-50 min-w-40 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 font-mono text-[11px] leading-5 text-(--color-text) shadow-lg"
          style={{ top: tooltipPosition.top, left: tooltipPosition.left }}
          role="tooltip"
          onMouseEnter={openHoverTooltip}
          onMouseLeave={closeHoverTooltip}
        >
          <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">input</span><span>{input.toLocaleString()}</span></div>
          <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">trigger</span><span>{safeTrigger.toLocaleString()}</span></div>
          <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">used</span><span>{percent}%</span></div>
          <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">output</span><span>{output.toLocaleString()}</span></div>
          <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">cache</span><span>{cached.toLocaleString()}</span></div>
          {/* Scope differs from the rows above on purpose: those describe this
              agent, while cost is summed across every agent in the session.
              Labelled so the two are not read as the same scope. */}
          {sessionCostUsd !== undefined && sessionCostUsd > 0 && (
            <div className="flex justify-between gap-4"><span className="text-(--color-text-muted)">session cost</span><span>{tokenMeterUsdFmt.format(sessionCostUsd)}</span></div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

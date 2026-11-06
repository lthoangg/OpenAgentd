/**
 * ThinkingControl — the phone run deck's own thinking button (user
 * request): a gauge chip naming the level; a tap blurs the screen and puts
 * one stepped slider in its middle. Dragging moves between the model's
 * levels (a tick of haptics on each), letting go saves, a tap outside
 * closes. The model chip then names only the model and account.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAgentStore } from '@/stores/useAgentStore'
import { selectionHapticFeedback } from '@/lib/haptics'
import { thinkingLevelLabel, thinkingLevelShortLabel } from '@/lib/run-settings'
import { cn } from '@/lib/utils'
import type { RunSettings } from './useRunSettings'

/** A dial: a 270° arc and a needle that sweeps it as `fraction` goes 0 → 1. */
export function ThinkingGauge({ fraction, px = 14, className }: { fraction: number; px?: number; className?: string }) {
  const angle = -135 + 270 * Math.min(1, Math.max(0, fraction))
  return (
    <svg width={px} height={px} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-thinking-gauge="" className={cn('shrink-0', className)}>
      <path d="M3.76 13.24A6 6 0 1 1 12.24 13.24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '8px 9px' }} className="transition-transform duration-(--motion-base) ease-(--ease-out)">
        <path d="M8 9V5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </g>
      <circle cx={8} cy={9} r={1.25} fill="currentColor" />
    </svg>
  )
}

/**
 * A Control Center slider: one thick track cut into a segment per level,
 * filled in the accent up to and including the chosen one, each level's
 * name inside its segment. A press or drag anywhere picks the segment
 * under the finger; letting go (or an arrow key) calls `onCommit`.
 */
function ThinkingSlider({ levels, value, onChange, onCommit }: {
  levels: string[]
  value: number
  onChange: (index: number) => void
  onCommit: (index: number) => void
}) {
  const latest = useRef(value)
  latest.current = value
  const count = levels.length
  const pick = (index: number) => {
    const next = Math.min(count - 1, Math.max(0, index))
    if (next !== latest.current) {
      selectionHapticFeedback()
      latest.current = next
      onChange(next)
    }
    return next
  }
  const indexAt = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 ? Math.floor(((clientX - rect.left) / rect.width) * count) : latest.current
  }
  const filled = ((value + 1) / count) * 100

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Thinking level"
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={value}
      aria-valuetext={thinkingLevelLabel(levels[value] ?? '')}
      data-thinking-slider=""
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId)
        pick(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) pick(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerUp={() => onCommit(latest.current)}
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : step === undefined ? null : latest.current + step
        if (next === null) return
        event.preventDefault()
        const before = latest.current
        if (pick(next) !== before) onCommit(latest.current)
      }}
      className="relative h-14 w-full cursor-pointer touch-none overflow-hidden rounded-2xl border border-(--color-border) bg-(--bg-card) shadow-(--shadow-depth) select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
    >
      <div
        aria-hidden="true"
        data-thinking-fill=""
        style={{ transform: `translateX(${filled - 100}%)` }}
        className="absolute inset-0 bg-(--color-accent) transition-transform duration-(--motion-base) ease-(--ease-out)"
      />
      <div aria-hidden="true" className="relative flex h-full">
        {levels.map((level, index) => (
          <span
            key={level}
            className={cn(
              'relative flex min-w-0 flex-1 items-center justify-center px-1 text-meta transition-colors duration-(--motion-base)',
              index <= value ? 'text-(--color-text-on-accent)' : 'text-(--color-text-2)',
              index === value && 'font-semibold',
            )}
          >
            {/* A hairline between segments; the edge of the fill is the one at the choice. */}
            {index > 0 && index !== value + 1 && (
              <span className={cn('absolute inset-y-4 left-0 w-px', index <= value ? 'bg-(--color-text-on-accent) opacity-25' : 'bg-(--color-border)')} />
            )}
            <span className="truncate">{thinkingLevelShortLabel(level)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function ThinkingControl({ settings, disabled = false }: { settings: RunSettings; disabled?: boolean }) {
  const levels = settings.thinkingLevels
  const [open, setOpen] = useState(false)
  const current = settings.thinkingLevel && levels.includes(settings.thinkingLevel) ? settings.thinkingLevel : levels[0]
  const [draft, setDraft] = useState<number>(Math.max(0, levels.indexOf(current ?? '')))
  useEffect(() => {
    if (open) setDraft(Math.max(0, levels.indexOf(current ?? '')))
  }, [open, current, levels])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (levels.length === 0) return null

  const commit = (index: number) => {
    const level = levels[index]
    if (level && level !== settings.thinkingLevel) void useAgentStore.getState().setSessionRunSettings({ thinkingLevel: level })
  }
  const label = current ? thinkingLevelLabel(current) : 'Off'
  const steps = Math.max(1, levels.length - 1)
  const currentIndex = Math.max(0, levels.indexOf(current ?? ''))

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Thinking ${label}. Change`}
        aria-haspopup="dialog"
        data-thinking-chip=""
        onClick={() => setOpen(true)}
        className="relative touch-hit flex h-9 shrink-0 items-center gap-1 rounded-sm px-2 text-subhead text-(--color-text-2) transition-colors duration-(--motion-instant) active:bg-(--bg-key) disabled:opacity-50"
      >
        <ThinkingGauge fraction={currentIndex / steps} />
        {current ? thinkingLevelShortLabel(current) : 'Off'}
      </button>
      {open && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Thinking level"
          data-thinking-overlay=""
          className="fixed inset-0 z-70 flex items-center justify-center bg-(--color-overlay) px-6 backdrop-blur-md animate-in fade-in-0 animation-duration-(--motion-base)"
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
        >
          <div className="w-full max-w-sm animate-in zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)">
            <div className="flex items-center justify-center gap-1.5 text-(--color-text-2)">
              <ThinkingGauge fraction={draft / steps} px={16} />
              <p className="text-meta font-medium">Thinking</p>
            </div>
            <p aria-live="polite" className="mt-1 text-center text-large-title font-bold text-(--color-text)">
              {thinkingLevelLabel(levels[draft] ?? '')}
            </p>
            <div className="mt-5">
              <ThinkingSlider levels={levels} value={draft} onChange={setDraft} onCommit={commit} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

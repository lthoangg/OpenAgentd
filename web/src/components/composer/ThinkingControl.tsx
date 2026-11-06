/**
 * ThinkingControl — the phone run deck's own thinking button (user
 * request): a gauge chip naming the level; a tap blurs the screen and puts
 * one stepped slider in its middle. Dragging moves between the model's
 * levels (a tick of haptics on each), letting go saves, a tap outside
 * closes. The model chip then names only the model and account.
 */
import { useEffect, useState } from 'react'
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
  const draftFraction = draft / steps

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
          className="fixed inset-0 z-70 flex items-center justify-center bg-(--color-overlay) px-8 backdrop-blur-md animate-in fade-in-0 animation-duration-(--motion-base)"
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
        >
          <div className="w-full max-w-sm animate-in zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)">
            <ThinkingGauge fraction={draftFraction} px={48} className="mx-auto text-(--color-text)" />
            <p className="mt-3 text-center text-meta font-medium text-(--color-text-2)">Thinking</p>
            <p aria-live="polite" className="mt-0.5 text-center text-large-title font-bold text-(--color-text)">
              {thinkingLevelLabel(levels[draft] ?? '')}
            </p>
            {/* The track, its fill and the step dots are drawn here; the
                native range sits on top (transparent track, real knob) so
                drag, VoiceOver and keys keep working. The drawn track is
                inset by the knob's radius, where the knob's centre travels. */}
            <div className="relative mt-6 h-8">
              <div aria-hidden="true" className="absolute inset-x-4 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-(--bg-key)">
                <div
                  data-thinking-fill=""
                  style={{ transform: `scaleX(${draftFraction})` }}
                  className="h-full w-full origin-left rounded-full bg-(--color-accent) transition-transform duration-(--motion-instant)"
                />
              </div>
              <div aria-hidden="true" className="absolute inset-x-4 top-1/2">
                {levels.map((level, index) => (
                  <span
                    key={level}
                    style={{ left: `${(index / steps) * 100}%` }}
                    className={cn(
                      'absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-(--motion-instant)',
                      index <= draft ? 'bg-(--color-text-on-accent)' : 'bg-(--color-text-muted)',
                    )}
                  />
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={levels.length - 1}
                step={1}
                value={draft}
                aria-label="Thinking level"
                aria-valuetext={thinkingLevelLabel(levels[draft] ?? '')}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (next !== draft) selectionHapticFeedback()
                  setDraft(next)
                }}
                onPointerUp={() => commit(draft)}
                onKeyUp={() => commit(draft)}
                className="oa-thinking-slider absolute inset-0 w-full"
              />
            </div>
            <div aria-hidden="true" className="relative mx-4 mt-2 h-5">
              {levels.map((level, index) => (
                <button
                  key={level}
                  type="button"
                  tabIndex={-1}
                  onClick={() => { if (index !== draft) selectionHapticFeedback(); setDraft(index); commit(index) }}
                  style={{ left: `${(index / steps) * 100}%` }}
                  className={cn(
                    'absolute -translate-x-1/2 whitespace-nowrap text-meta transition-colors duration-(--motion-instant)',
                    index === draft ? 'font-semibold text-(--color-text)' : 'text-(--color-text-muted)',
                  )}
                >
                  {thinkingLevelShortLabel(level)}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

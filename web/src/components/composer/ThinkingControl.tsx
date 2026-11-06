/**
 * ThinkingControl — the phone run deck's own thinking button (user
 * request): a chip naming the level; a tap blurs the screen and puts one
 * stepped slider in its middle. Dragging moves between the model's levels
 * (a tick of haptics on each), letting go saves, a tap outside closes.
 * The model chip then names only the model and account.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Brain } from 'lucide-react'

import { useAgentStore } from '@/stores/useAgentStore'
import { selectionHapticFeedback } from '@/lib/haptics'
import { thinkingLevelLabel, thinkingLevelShortLabel } from '@/lib/run-settings'
import { cn } from '@/lib/utils'
import type { RunSettings } from './useRunSettings'

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
        <Brain size={14} aria-hidden="true" className="shrink-0" />
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
            <p className="text-center text-meta font-medium text-(--color-text-2)">Thinking</p>
            <p aria-live="polite" className="mt-1 text-center text-large-title font-bold text-(--color-text)">
              {thinkingLevelLabel(levels[draft] ?? '')}
            </p>
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
              className="oa-thinking-slider mt-6 w-full"
            />
            <div aria-hidden="true" className="mt-2 flex justify-between">
              {levels.map((level, index) => (
                <span key={level} className={cn('text-meta', index === draft ? 'font-semibold text-(--color-text)' : 'text-(--color-text-muted)')}>
                  {thinkingLevelShortLabel(level)}
                </span>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

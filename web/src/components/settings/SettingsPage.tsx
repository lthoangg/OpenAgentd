/**
 * SettingsPage — the shared shell for every settings section.
 *
 * Replaces the header markup that was copy-pasted verbatim into seven pages:
 *   <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2
 *     border-b border-(--color-border) bg-(--bg-page) px-4 select-none"> …
 * plus the `mx-auto max-w-3xl space-y-4 p-3 sm:p-5` body wrapper and the
 * ad-hoc `isLoading && <p>Loading…</p>` / error blocks each page rewrote.
 *
 * It also owns the one save affordance in the product: a sticky action bar
 * that appears only when the draft is dirty, with Reset, Save, and a Cmd/Ctrl+S
 * binding. Pages pass the `useSettingsDraft` result and stop worrying about it.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, RotateCcw, Save, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ICON_SIZE, TEXT } from '@/components/settings/tokens'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import type { DraftControls } from '@/components/settings/useSettingsDraft'
import { EASINGS } from '@/lib/motion'

interface SettingsPageProps {
  /** Section title shown in the sticky header. */
  title: string
  /** Header glyph. Omit for pages that carry their own identity block. */
  icon?: LucideIcon
  /** Short explanation rendered above the first section. */
  intro?: ReactNode
  /** Draft state; when present the save bar and Cmd+S binding are wired up. */
  draft?: DraftControls
  /** Renders the loading skeleton instead of children. */
  loading?: boolean
  /** Renders the error state instead of children. */
  error?: unknown
  children: ReactNode
}

export function SettingsPage({
  title,
  icon: Icon,
  intro,
  draft,
  loading = false,
  error,
  children,
}: SettingsPageProps) {
  // Read through a ref inside the handler so the listener is bound once per
  // page rather than re-bound on every keystroke: `draft.save` and `canSave`
  // both change identity whenever the draft value does.
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // Cmd/Ctrl+S saves without hunting for the button.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) return
      const current = draftRef.current
      if (!current?.canSave) return
      e.preventDefault()
      void current.save()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-4 select-none">
        {Icon && (
          <Icon
            size={ICON_SIZE}
            className="shrink-0 text-(--color-text-muted)"
            aria-hidden="true"
          />
        )}
        <h1 className={cn('flex-1 truncate', TEXT.title)}>{title}</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
          {intro && <p className={TEXT.body}>{intro}</p>}

          {loading ? (
            <SettingsSkeleton />
          ) : error ? (
            <SettingsError error={error} />
          ) : (
            children
          )}
        </div>
      </div>

      {draft && <SaveBar draft={draft} />}
    </>
  )
}

// ── Save bar ──────────────────────────────────────────────────────────────

/** Save-bar enter/exit. Module scope so framer sees a stable target
 *  reference. Reduced motion fades instead of sliding: the global CSS guard in
 *  index.css only covers CSS transitions, not framer's JS-driven transforms. */
const SAVE_BAR_MOTION = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
} as const
const SAVE_BAR_MOTION_REDUCED = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const

function SaveBar({ draft }: { draft: DraftControls }) {
  const prefersReducedMotion = useReducedMotion()
  const slide = prefersReducedMotion ? SAVE_BAR_MOTION_REDUCED : SAVE_BAR_MOTION

  return (
    <AnimatePresence>
      {draft.dirty && (
        <motion.div
          initial={slide.initial}
          animate={slide.animate}
          exit={slide.exit}
          transition={{ duration: prefersReducedMotion ? 0 : 0.16, ease: EASINGS.out }}
          className={cn(
            'sticky bottom-0 z-20 flex shrink-0 items-center gap-3',
            'border-t border-(--color-border) bg-(--bg-sidebar) px-4 py-2',
          )}
          role="region"
          aria-label="Unsaved changes"
        >
          <span className={cn('flex-1', TEXT.hint)} aria-live="polite">
            Unsaved changes
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 md:min-h-0"
            onClick={draft.reset}
            disabled={draft.isSaving}
          >
            <RotateCcw size={12} aria-hidden="true" />
            Reset
          </Button>
          <Button
            size="sm"
            className="min-h-11 md:min-h-0"
            onClick={() => void draft.save()}
            disabled={!draft.canSave}
          >
            <Save size={12} aria-hidden="true" />
            {draft.isSaving ? 'Saving…' : 'Save'}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── Loading / error states ────────────────────────────────────────────────

/**
 * Shape-matched skeleton rather than a spinner, so the layout does not shift
 * when the real sections land.
 */
function SettingsSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading settings">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)"
        >
          <div className="h-7 border-b border-(--color-border)/60 bg-(--bg-key)/30" />
          <div className="space-y-2.5 px-3 py-3">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

function SettingsError({ error }: { error: unknown }) {
  return (
    <div
      className="flex items-start gap-2 rounded-sm border border-(--color-error)/20 bg-(--color-error-subtle) p-3 text-(--color-error)"
      role="alert"
    >
      <AlertCircle size={ICON_SIZE} aria-hidden="true" className="mt-px shrink-0" />
      <span className={TEXT.bodyTight}>
        {error instanceof Error ? error.message : String(error)}
      </span>
    </div>
  )
}

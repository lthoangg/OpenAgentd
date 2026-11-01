/**
 * SettingsPage — the shared shell for every settings section.
 *
 * Owns the page header (title, description, actions), the body column and its
 * rhythm between sections, and the loading / error states, so every section
 * page reads the same.
 *
 * Two layouts: `scroll` (default) scrolls the header with the content;
 * `fill` pins the header and gives children the remaining height, for pages
 * with their own panes (Memory).
 *
 * It also owns the one save affordance in the product: a sticky action bar
 * (`SaveBar`) that appears only when the draft is dirty, with Discard…, Save,
 * and a Cmd/Ctrl+S binding. Pages pass the `useSettingsDraft` result and stop
 * worrying about it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { PAGE_BODY, TEXT } from '@/components/settings/tokens'
import { Callout } from '@/components/ui/callout'
import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'
import type { DraftControls } from '@/components/settings/useSettingsDraft'
import { SaveBar } from '@/components/settings/SaveBar'
import { settingsRoot } from '@/components/settings/settings-root'
import { APP_SHORTCUTS, chordOf } from '@/lib/app-shortcuts'
import { useShortcut } from '@/lib/keyboard/hooks'

interface SettingsPageProps {
  /** Page title (the page's only `h1`). */
  title: string
  /** Short explanation under the title. */
  description?: ReactNode
  /** Controls aligned with the title (New, Refresh, a status count). */
  actions?: ReactNode
  /** `fill` pins the header and lets children take the remaining height. */
  layout?: 'scroll' | 'fill'
  /** Draft state; when present the save bar and Cmd+S binding are wired up. */
  draft?: DraftControls
  /** Renders the loading skeleton instead of children. */
  loading?: boolean
  /** Renders the error state instead of children. */
  error?: unknown
  /** Why Save is disabled while the draft is dirty, shown on the save bar. */
  saveBlockedReason?: string | null
  /** Ask before saving when the save deletes data (e.g. a shorter retention). */
  confirmSave?: { when: boolean; title: string; description: string; confirmLabel: string }
  children: ReactNode
}

export function SettingsPage({
  title,
  description,
  actions,
  layout = 'scroll',
  draft,
  loading = false,
  error,
  saveBlockedReason,
  confirmSave,
  children,
}: SettingsPageProps) {
  const [confirmingSave, setConfirmingSave] = useState(false)
  const confirmSaveRef = useRef(confirmSave)
  confirmSaveRef.current = confirmSave
  const requestSave = () => {
    const current = draftRef.current
    if (!current?.canSave) return
    if (confirmSaveRef.current?.when) setConfirmingSave(true)
    else void current.save()
  }
  useUnsavedSettings(Boolean(draft?.dirty || draft?.isSaving))
  // Read through a ref inside the handler so the listener is bound once per
  // page rather than re-bound on every keystroke: `draft.save` and `canSave`
  // both change identity whenever the draft value does.
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // ⌘S / Ctrl+S saves without hunting for the button.
  useShortcut(chordOf(APP_SHORTCUTS.save), () => {
    const current = draftRef.current
    if (!current?.canSave) return false
    requestSave()
  }, { within: settingsRoot })

  const saveBar = draft && (
    <>
      <SaveBar draft={draft} onSave={requestSave} saveBlockedReason={saveBlockedReason} />
      {confirmSave && (
        <ConfirmDialog
          open={confirmingSave}
          onOpenChange={setConfirmingSave}
          title={confirmSave.title}
          description={confirmSave.description}
          confirmLabel={confirmSave.confirmLabel}
          onConfirm={() => draft.save()}
        />
      )}
    </>
  )

  const body = loading ? <SettingsSkeleton /> : error ? <SettingsError error={error} /> : children
  const header = <SettingsPageHeader title={title} description={description} actions={actions} />

  if (layout === 'fill') {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col bg-(--bg-page)">
          <div className="w-full shrink-0 px-4 md:px-8">{header}</div>
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        </div>
        {saveBar}
      </>
    )
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className={cn(PAGE_BODY, 'pb-12')}>
          {header}
          <div className="space-y-6 md:space-y-8">{body}</div>
        </div>
      </div>

      {saveBar}
    </>
  )
}

/**
 * Page title, description and actions. Exported for pages that cannot use the
 * full shell (editors with their own sub-header).
 *
 * On phones the overlay header already names the section, so the title is
 * kept for screen readers only there.
 */
export function SettingsPageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-3 pt-5 pb-6 sm:flex-row sm:items-start sm:gap-6 md:pt-8 md:pb-7">
      <div className="min-w-0 flex-1">
        <h1 className={cn('max-md:sr-only', TEXT.pageTitle)}>{title}</h1>
        {description && (
          <div className={cn('max-w-prose md:mt-1.5', TEXT.body)}>{description}</div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 select-none">{actions}</div>
      )}
    </header>
  )
}

// ── Loading / error states ────────────────────────────────────────────────

/**
 * Shape-matched skeleton rather than a spinner, so the layout does not shift
 * when the real sections land.
 */
export function SettingsSkeleton({ label = 'Loading settings' }: { label?: string }) {
  return (
    <div className="oa-fade-in-late space-y-6 md:space-y-8" role="status" aria-label={label}>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-3 w-32" />
          <div className="overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
            <div className="space-y-3 px-4 py-4">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function SettingsError({ error }: { error: unknown }) {
  const queryClient = useQueryClient()
  return (
    <Callout
      tone="error"
      role="alert"
      title="Couldn't load these settings"
      action={
        <Button size="sm" variant="default" onClick={() => { void queryClient.refetchQueries({ type: 'active' }) }}>
          Retry
        </Button>
      }
    >
      {error instanceof Error ? error.message : String(error)}
    </Callout>
  )
}

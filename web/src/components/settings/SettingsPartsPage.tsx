/**
 * A settings page made of parts that each load and save their own resource
 * (Sessions: titles, summaries, goals, history). The page shows one save bar:
 * only the parts that were edited are saved, and a mistake in one part does
 * not block saving another. Each part loads and fails on its own too: one
 * that cannot be read shows its error in its place, and the others stay.
 */
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { SettingsPage } from '@/components/settings/SettingsPage'
import { combineDrafts, type DraftControls } from '@/components/settings/useSettingsDraft'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { Skeleton } from '@/components/ui/skeleton'

export interface SettingsPart {
  /** The part's draft, with `canSave` already narrowed by its validation. */
  draft: DraftControls
  loading: boolean
  error: unknown
  /** Why this part cannot be saved, for the save bar. */
  saveBlockedReason?: string | null
  /** Ask before saving when this part's save deletes data. */
  confirmSave?: { when: boolean; title: string; description: string; confirmLabel: string }
  /** The part's heading, shown over its loading and error states. */
  title: string
  /** The part's section (a keyed `PanelSection`). */
  body: ReactNode
}

/** A part that is still loading, or could not be read: in its own place, under its own heading. */
function PartState({ part }: { part: SettingsPart }) {
  const queryClient = useQueryClient()
  if (part.loading) {
    return (
      <PanelSection title={part.title}>
        <div className="space-y-3" role="status" aria-label={`Loading ${part.title}`}>
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PanelSection>
    )
  }
  return (
    <PanelSection title={part.title}>
      <Callout
        tone="error"
        role="alert"
        title={`Couldn't load ${part.title}`}
        action={
          <Button size="sm" variant="default" onClick={() => { void queryClient.refetchQueries({ type: 'active' }) }}>
            Retry
          </Button>
        }
      >
        {part.error instanceof Error ? part.error.message : String(part.error)}
      </Callout>
    </PanelSection>
  )
}

export function SettingsPartsPage({ title, description, parts }: {
  title: string
  description: string
  parts: readonly SettingsPart[]
}) {
  const edited = parts.filter((part) => part.draft.dirty)
  return (
    <SettingsPage
      title={title}
      description={description}
      draft={combineDrafts(parts.map((part) => part.draft))}
      saveBlockedReason={edited.find((part) => part.saveBlockedReason)?.saveBlockedReason ?? null}
      confirmSave={edited.find((part) => part.confirmSave?.when)?.confirmSave ?? parts.find((part) => part.confirmSave)?.confirmSave}
    >
      {parts.map((part) => (part.loading || part.error ? <PartState key={part.title} part={part} /> : part.body))}
    </SettingsPage>
  )
}

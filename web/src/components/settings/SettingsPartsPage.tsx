/**
 * A settings page made of parts that each load and save their own resource
 * (Sessions: titles, summaries, goals, history). The page shows one save bar:
 * only the parts that were edited are saved, and a mistake in one part does
 * not block saving another.
 */
import type { ReactNode } from 'react'

import { SettingsPage } from '@/components/settings/SettingsPage'
import { combineDrafts, type DraftControls } from '@/components/settings/useSettingsDraft'

export interface SettingsPart {
  /** The part's draft, with `canSave` already narrowed by its validation. */
  draft: DraftControls
  loading: boolean
  error: unknown
  /** Why this part cannot be saved, for the save bar. */
  saveBlockedReason?: string | null
  /** Ask before saving when this part's save deletes data. */
  confirmSave?: { when: boolean; title: string; description: string; confirmLabel: string }
  /** The part's section (a keyed `PanelSection`). */
  body: ReactNode
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
      loading={parts.some((part) => part.loading)}
      error={parts.find((part) => part.error)?.error}
    >
      {parts.map((part) => part.body)}
    </SettingsPage>
  )
}

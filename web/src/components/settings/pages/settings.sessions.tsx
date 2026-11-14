/**
 * Settings → Sessions: names, summaries, goals and history on one page (they
 * were four: Session titles, Context, Goals, Retention). Each heading is the
 * anchor its old section id opens (`useSettingsStore`).
 */
import { SettingsPartsPage } from '@/components/settings/SettingsPartsPage'
import { useSummariesPart } from '@/components/settings/pages/settings.context'
import { useGoalsPart } from '@/components/settings/pages/settings.goals'
import { useHistoryPart } from '@/components/settings/pages/settings.telemetry'
import { useTitlesPart } from '@/components/settings/pages/settings.titles'

export function SessionsSettingsPage() {
  const parts = [useTitlesPart(), useSummariesPart(), useGoalsPart(), useHistoryPart()]
  return <SettingsPartsPage title="Sessions" description="Names, summaries, goals and history." parts={parts} />
}

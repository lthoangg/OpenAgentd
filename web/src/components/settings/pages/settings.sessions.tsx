/**
 * Settings → Sessions: names, summaries, goals and history on one page (they
 * were four: Session titles, Context, Goals, Retention). Each heading is the
 * anchor its old section id opens (`useSettingsStore`).
 */
import { SettingsPartsPage } from '@/components/settings/SettingsPartsPage'
import { useSummariesPart } from '@/components/settings/pages/sessions/summaries'
import { useGoalsPart } from '@/components/settings/pages/sessions/goals'
import { useHistoryPart } from '@/components/settings/pages/sessions/history'
import { useTitlesPart } from '@/components/settings/pages/sessions/titles'

export function SessionsSettingsPage() {
  const parts = [useTitlesPart(), useSummariesPart(), useGoalsPart(), useHistoryPart()]
  return <SettingsPartsPage title="Sessions" description="Names, summaries, goals and history." parts={parts} />
}

/**
 * Settings → Goals — `/goal` defaults: how many turns and tokens a goal may
 * take, and whether goal turns may ask the user questions. The completion
 * check always runs on the session's own model, so it keeps the prompt cache.
 */
import { useGoalSettingsQuery, useUpdateGoalSettingsMutation } from '@/queries/useGoalSettingsQuery'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { GoalSettings } from '@/api/client'
import { formatGoalTokens } from '@/lib/goal'

/** Matches ``appv3_core::runtime_settings::MAX_GOAL_MAX_TURNS``. */
const MAX_TURNS_LIMIT = 1000

type GoalForm = Pick<GoalSettings, 'max_turns' | 'token_budget' | 'allow_questions'>

/** Shown only until the settings load. */
const GOALS_DEFAULT: GoalForm = { max_turns: 50, token_budget: null, allow_questions: false }

function hydrateGoals(data: GoalForm): GoalForm {
  return { max_turns: data.max_turns, token_budget: data.token_budget ?? null, allow_questions: data.allow_questions ?? false }
}

function normalizeGoals(form: GoalForm): GoalForm {
  const budget = form.token_budget
  return {
    max_turns: Math.floor(form.max_turns),
    token_budget: budget === null || !Number.isFinite(budget) ? null : Math.floor(budget),
    allow_questions: form.allow_questions,
  }
}

/** Why the budget cannot be saved, if it cannot (``null`` is no budget). */
function budgetError(budget: number | null): string | null {
  return budget !== null && (!Number.isFinite(budget) || budget < 1) ? 'A whole number of tokens, or empty for no budget.' : null
}

export function GoalsSettingsPage() {
  const goalsQ = useGoalSettingsQuery()
  const updateGoals = useUpdateGoalSettingsMutation()

  const draft = useSettingsDraft<GoalForm>({
    data: goalsQ.data,
    initial: GOALS_DEFAULT,
    normalize: normalizeGoals,
    hydrate: hydrateGoals,
    onSave: (value) => updateGoals.mutateAsync(value),
    successTitle: 'Goal settings saved',
  })
  const maxTurns = draft.value.max_turns
  const maxTurnsError = !Number.isFinite(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS_LIMIT
    ? `A whole number from 1 to ${MAX_TURNS_LIMIT}.`
    : null
  const budget = draft.value.token_budget
  const tokenBudgetError = budgetError(budget)
  const defaultTurns = goalsQ.data?.default_max_turns ?? GOALS_DEFAULT.max_turns

  return (
    <SettingsPage
      title="Goals"
      description="With /goal, the agent keeps taking turns until a check confirms the goal is met, it reports a blocker, or a limit pauses it."
      draft={{ ...draft, canSave: draft.canSave && !maxTurnsError && !tokenBudgetError }}
      loading={goalsQ.isLoading}
      error={goalsQ.error}
    >
      <PanelSection title="Limits" flush>
        <PanelRow
          label="Turns per goal"
          htmlFor="goals-max-turns"
          description={`A turn is one full agent reply, often with many tool calls. The goal pauses when it runs out; Resume grants another batch. Default ${defaultTurns}. Applies to new goals.`}
          error={maxTurnsError}
        >
          <Input
            id="goals-max-turns"
            type="number"
            min={1}
            max={MAX_TURNS_LIMIT}
            aria-label="Turns per goal"
            value={Number.isFinite(maxTurns) ? String(maxTurns) : ''}
            onChange={(e) => draft.patch({ max_turns: parseInt(e.target.value, 10) })}
            className="h-9 w-24 font-mono"
          />
        </PanelRow>
        <PanelRow
          label="Token budget per goal"
          htmlFor="goals-token-budget"
          description={`Counts uncached input and output tokens across the goal's turns and checks. The goal pauses when it reaches the budget; Resume grants another. Empty means no budget. Applies to new goals.${budget !== null && !tokenBudgetError ? ` Now ${formatGoalTokens(budget)}.` : ''}`}
          error={tokenBudgetError}
        >
          <Input
            id="goals-token-budget"
            type="number"
            min={1}
            step={100000}
            aria-label="Token budget per goal"
            value={budget === null ? '' : Number.isFinite(budget) ? String(budget) : ''}
            onChange={(e) => draft.patch({ token_budget: e.target.value.trim() === '' ? null : parseInt(e.target.value, 10) })}
            className="h-9 w-32 font-mono"
          />
        </PanelRow>
      </PanelSection>

      <PanelSection title="While a goal runs" flush>
        <PanelRow
          label="Let the agent ask me questions during a goal"
          htmlFor="goals-allow-questions"
          description="Off: goal turns run unattended, and the agent decides on its own and notes each choice. On: it may stop to ask, and the goal waits for your answer."
        >
          <Switch
            id="goals-allow-questions"
            checked={draft.value.allow_questions}
            onCheckedChange={(checked) => draft.patch({ allow_questions: checked })}
          />
        </PanelRow>
      </PanelSection>
    </SettingsPage>
  )
}

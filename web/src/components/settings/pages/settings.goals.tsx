/**
 * Settings → Sessions → Goals: defaults for the goal an approved plan runs ("Keep going
 * until done"): whether the plan review starts with Keep going ticked, how
 * many turns and tokens a goal may take (the review can change the turns for
 * one plan), and whether goal turns may ask the user questions. The
 * completion check always runs on the session's own model, so it keeps the
 * prompt cache.
 */
import { useGoalSettingsQuery, useUpdateGoalSettingsMutation } from '@/queries/useGoalSettingsQuery'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { SettingsPart } from '@/components/settings/SettingsPartsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { GoalSettings } from '@/api/client'
import { formatGoalTokens } from '@/lib/goal'

/** Matches ``appv3_core::runtime_settings::MAX_GOAL_MAX_TURNS``. */
const MAX_TURNS_LIMIT = 1000

type GoalForm = Pick<GoalSettings, 'max_turns' | 'token_budget' | 'allow_questions' | 'keep_going_default'>

/** Shown only until the settings load. */
const GOALS_DEFAULT: GoalForm = { max_turns: 50, token_budget: null, allow_questions: false, keep_going_default: false }

function hydrateGoals(data: GoalForm): GoalForm {
  return {
    max_turns: data.max_turns,
    token_budget: data.token_budget ?? null,
    allow_questions: data.allow_questions ?? false,
    keep_going_default: data.keep_going_default ?? false,
  }
}

function normalizeGoals(form: GoalForm): GoalForm {
  const budget = form.token_budget
  return {
    max_turns: Math.floor(form.max_turns),
    token_budget: budget === null || !Number.isFinite(budget) ? null : Math.floor(budget),
    allow_questions: form.allow_questions,
    keep_going_default: form.keep_going_default,
  }
}

/** Why the budget cannot be saved, if it cannot (``null`` is no budget). */
function budgetError(budget: number | null): string | null {
  return budget !== null && (!Number.isFinite(budget) || budget < 1) ? 'A whole number of tokens, or empty for no budget.' : null
}

export function useGoalsPart(): SettingsPart {
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

  return {
    draft: { ...draft, canSave: draft.canSave && !maxTurnsError && !tokenBudgetError },
    saveBlockedReason: maxTurnsError ? 'Fix turns per goal to save.' : tokenBudgetError ? 'Fix the token budget to save.' : null,
    loading: goalsQ.isLoading,
    error: goalsQ.error,
    body: (
      <PanelSection key="goals" title="Goals" flush>
        <PanelRow label="Keep going after approval" htmlFor="goals-keep-going-default" description="Starts each plan review with it ticked.">
          <Switch
            id="goals-keep-going-default"
            checked={draft.value.keep_going_default}
            onCheckedChange={(checked) => draft.patch({ keep_going_default: checked })}
          />
        </PanelRow>
        <PanelRow
          label="Turns per goal"
          htmlFor="goals-max-turns"
          inline
          description={`A turn is one full reply. The goal pauses when they run out. Default ${defaultTurns}.`}
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
            className="h-9 w-20! md:w-24! no-spin text-right font-mono tabular-nums"
          />
          <span className="text-xs text-(--color-text-2)">turns</span>
        </PanelRow>
        <PanelRow
          label="Token budget per goal"
          htmlFor="goals-token-budget"
          inline
          description={`The goal pauses at the budget.${budget !== null && !tokenBudgetError ? ` Now ≈ ${formatGoalTokens(budget)} tokens.` : ''}`}
          error={tokenBudgetError}
        >
          <Input
            id="goals-token-budget"
            type="number"
            min={1}
            step={100000}
            aria-label="Token budget per goal"
            placeholder="No limit"
            value={budget === null ? '' : Number.isFinite(budget) ? String(budget) : ''}
            onChange={(e) => draft.patch({ token_budget: e.target.value.trim() === '' ? null : parseInt(e.target.value, 10) })}
            className="h-9 w-28! md:w-32! no-spin text-right font-mono tabular-nums"
          />
          <span className="text-xs text-(--color-text-2)">tokens</span>
        </PanelRow>
        <PanelRow
          label="Allow questions during goals"
          htmlFor="goals-allow-questions"
          description="Off: the agent decides alone and notes each choice."
        >
          <Switch
            id="goals-allow-questions"
            checked={draft.value.allow_questions}
            onCheckedChange={(checked) => draft.patch({ allow_questions: checked })}
          />
        </PanelRow>
      </PanelSection>
    ),
  }
}

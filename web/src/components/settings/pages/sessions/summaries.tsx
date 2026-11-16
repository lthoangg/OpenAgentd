/**
 * Settings → Sessions → Summaries: when long sessions are summarized
 * (compacted) to fit the model's context window, including idle compaction.
 */
import {
  useSummarizationSettingsQuery,
  useUpdateSummarizationSettingsMutation,
} from '@/queries'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { SettingsPart } from '@/components/settings/SettingsPartsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { SummarizationSettings } from '@/api/client'

const SUMMARIZATION_DEFAULT: SummarizationSettings = {
  prompt_token_threshold: null,
  idle_compaction: false,
  idle_compaction_percent: null,
}

/** Backend default for `idle_compaction_percent: null`. */
const DEFAULT_IDLE_COMPACTION_PERCENT = 70

function normalizeSummarization(form: SummarizationSettings): SummarizationSettings {
  return {
    prompt_token_threshold:
      form.prompt_token_threshold !== null && form.prompt_token_threshold > 0
        ? Math.floor(form.prompt_token_threshold)
        : null,
    idle_compaction: form.idle_compaction,
    idle_compaction_percent:
      form.idle_compaction_percent !== null ? Math.floor(form.idle_compaction_percent) : null,
  }
}

/** Older backends omit the idle-compaction keys. */
function hydrateSummarization(data: SummarizationSettings): SummarizationSettings {
  return {
    prompt_token_threshold: data.prompt_token_threshold ?? null,
    idle_compaction: data.idle_compaction ?? false,
    idle_compaction_percent: data.idle_compaction_percent ?? null,
  }
}

/** Empty input → null, otherwise the parsed integer. */
function parseOptionalInt(raw: string): number | null {
  const parsed = parseInt(raw, 10)
  return raw.trim() === '' || Number.isNaN(parsed) ? null : parsed
}

export function useSummariesPart(): SettingsPart {
  const summarizationQ = useSummarizationSettingsQuery()
  const updateSummarization = useUpdateSummarizationSettingsMutation()

  const draft = useSettingsDraft({
    data: summarizationQ.data,
    initial: SUMMARIZATION_DEFAULT,
    normalize: normalizeSummarization,
    hydrate: hydrateSummarization,
    onSave: (value) => updateSummarization.mutateAsync(value),
    successTitle: 'Summary settings saved',
  })

  const threshold = draft.value.prompt_token_threshold
  const thresholdError =
    threshold !== null && threshold < 1
      ? 'A whole number of tokens, or empty for Auto.'
      : null
  const idleCompaction = draft.value.idle_compaction
  const idlePercent = draft.value.idle_compaction_percent
  const idlePercentError =
    idleCompaction && idlePercent !== null && (idlePercent < 1 || idlePercent > 100)
      ? 'A whole number from 1 to 100, or empty for 70.'
      : null

  return {
    draft: { ...draft, canSave: draft.canSave && !thresholdError && !idlePercentError },
    saveBlockedReason: thresholdError ? 'Fix the summary threshold to save.' : idlePercentError ? 'Fix how full an idle session must be to save.' : null,
    title: 'Summaries',
    loading: summarizationQ.isLoading,
    error: summarizationQ.error,
    body: (
      <PanelSection key="summaries" title="Summaries" flush>
        <PanelRow
          label="Summarize when a session reaches"
          htmlFor="context-threshold"
          inline
          description={`Empty means 90% of what the model can hold.${threshold !== null && Number.isFinite(threshold) && threshold > 0 ? ` Now ${threshold.toLocaleString('en-US')} tokens.` : ''}`}
          error={thresholdError}
        >
          <Input
            id="context-threshold"
            type="number"
            min={1}
            step={1000}
            placeholder="Auto"
            aria-label="Summarize when a session reaches"
            value={threshold === null ? '' : String(threshold)}
            onChange={(e) => draft.patch({ prompt_token_threshold: parseOptionalInt(e.target.value) })}
            className="h-9 w-32! no-spin text-right font-mono tabular-nums"
          />
          <span className="text-xs text-(--color-text-2)">tokens</span>
        </PanelRow>
        <PanelRow label="Summarize idle sessions" htmlFor="context-idle" description="After 4½ idle minutes. One extra model call.">
          <Switch
            id="context-idle"
            checked={idleCompaction}
            onCheckedChange={(checked) => draft.patch({ idle_compaction: checked })}
          />
        </PanelRow>
        {/* Shown once its switch is on: a row that cannot be used takes no room. */}
        {idleCompaction && (
          <PanelRow
            label="Only once it is this full"
            htmlFor="context-idle-percent"
            inline
            description="A percent of the size above. Empty means 70%."
            error={idlePercentError}
          >
            <div className="flex items-center gap-2">
              <Input
                id="context-idle-percent"
                type="number"
                min={1}
                max={100}
                step={5}
                placeholder={String(DEFAULT_IDLE_COMPACTION_PERCENT)}
                aria-label="Only once it is this full"
                value={idlePercent === null ? '' : String(idlePercent)}
                onChange={(e) => draft.patch({ idle_compaction_percent: parseOptionalInt(e.target.value) })}
                className="h-9 w-20! md:w-24! no-spin text-right font-mono tabular-nums"
              />
              <span className="text-xs text-(--color-text-muted)" aria-hidden="true">%</span>
            </div>
          </PanelRow>
        )}
      </PanelSection>
    ),
  }
}

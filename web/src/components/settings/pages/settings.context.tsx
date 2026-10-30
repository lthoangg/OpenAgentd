/**
 * Settings → Context — when long sessions are summarized (compacted) to fit
 * the model's context window, including idle compaction.
 */
import {
  useSummarizationSettingsQuery,
  useUpdateSummarizationSettingsMutation,
} from '@/queries'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsPage } from '@/components/settings/SettingsPage'
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

export function ContextSettingsPage() {
  const summarizationQ = useSummarizationSettingsQuery()
  const updateSummarization = useUpdateSummarizationSettingsMutation()

  const draft = useSettingsDraft({
    data: summarizationQ.data,
    initial: SUMMARIZATION_DEFAULT,
    normalize: normalizeSummarization,
    hydrate: hydrateSummarization,
    onSave: (value) => updateSummarization.mutateAsync(value),
    successTitle: 'Summarization settings saved',
  })

  const threshold = draft.value.prompt_token_threshold
  const thresholdError =
    threshold !== null && threshold < 1
      ? 'Must be a positive integer, or leave empty to use the auto value.'
      : null
  const idleCompaction = draft.value.idle_compaction
  const idlePercent = draft.value.idle_compaction_percent
  const idlePercentError =
    idleCompaction && idlePercent !== null && (idlePercent < 1 || idlePercent > 100)
      ? 'Must be a whole number from 1 to 100, or leave empty for 70.'
      : null

  return (
    <SettingsPage
      title="Context"
      description="Long sessions are summarized so they keep fitting the model's context window."
      draft={{ ...draft, canSave: draft.canSave && !thresholdError && !idlePercentError }}
      loading={summarizationQ.isLoading}
      error={summarizationQ.error}
    >
      <PanelSection title="Summarization" flush>
        <PanelRow
          label="Token threshold"
          htmlFor="context-threshold"
          description={`Summarize earlier messages once a prompt reaches this many tokens. Empty uses 90% of the model's context window.${threshold !== null && Number.isFinite(threshold) && threshold > 0 ? ` Now ${threshold.toLocaleString('en-US')} tokens.` : ''}`}
          error={thresholdError}
        >
          <Input
            id="context-threshold"
            type="number"
            min={1}
            step={1000}
            placeholder="Auto (90%)"
            aria-label="Token threshold"
            value={threshold === null ? '' : String(threshold)}
            onChange={(e) => draft.patch({ prompt_token_threshold: parseOptionalInt(e.target.value) })}
            className="h-9 w-36 font-mono"
          />
        </PanelRow>
      </PanelSection>

      <PanelSection
        title="Idle sessions"
        description="Summarize a session after 4½ idle minutes, while the model's cache is still warm. Uses one extra model call."
        flush
      >
        <PanelRow label="Summarize idle sessions" htmlFor="context-idle">
          <Switch
            id="context-idle"
            checked={idleCompaction}
            onCheckedChange={(checked) => draft.patch({ idle_compaction: checked })}
          />
        </PanelRow>
        <PanelRow
          label="Idle trigger"
          htmlFor="context-idle-percent"
          description={
            idleCompaction
              ? 'The percent of the token threshold a session must reach first. Empty uses 70%.'
              : 'Turn on Summarize idle sessions to change this.'
          }
          error={idlePercentError}
        >
          <div className="flex items-center gap-2">
            <Input
              id="context-idle-percent"
              type="number"
              min={1}
              max={100}
              step={5}
              disabled={!idleCompaction}
              placeholder={String(DEFAULT_IDLE_COMPACTION_PERCENT)}
              aria-label="Idle trigger percent"
              value={idlePercent === null ? '' : String(idlePercent)}
              onChange={(e) => draft.patch({ idle_compaction_percent: parseOptionalInt(e.target.value) })}
              className="h-9 w-24 font-mono"
            />
            <span className="text-xs text-(--color-text-muted)" aria-hidden="true">%</span>
          </div>
        </PanelRow>
      </PanelSection>
    </SettingsPage>
  )
}

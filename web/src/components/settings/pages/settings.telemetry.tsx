/**
 * Settings → Telemetry — how many days local traces and metrics are kept.
 * A daily sweep deletes older files; saving a new value sweeps right away.
 * The ``OPENAGENTD_OTEL_*_RETENTION_DAYS`` variables override the setting.
 */
import { useTelemetrySettingsQuery, useUpdateTelemetrySettingsMutation } from '@/queries/useTelemetrySettingsQuery'
import { Input } from '@/components/ui/input'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { TelemetrySettings } from '@/api/client'

type TelemetryForm = Pick<TelemetrySettings, 'retention_days'>

/** Shown only until the settings load. Matches ``DEFAULT_TELEMETRY_RETENTION_DAYS``. */
const TELEMETRY_DEFAULT: TelemetryForm = { retention_days: 90 }
/** Matches ``MAX_TELEMETRY_RETENTION_DAYS``. */
const FALLBACK_MAX_DAYS = 3650

function hydrateTelemetry(data: TelemetryForm): TelemetryForm {
  return { retention_days: data.retention_days }
}

function normalizeTelemetry(form: TelemetryForm): TelemetryForm {
  return { retention_days: Math.floor(form.retention_days) }
}

export function TelemetrySettingsPage() {
  const telemetryQ = useTelemetrySettingsQuery()
  const updateTelemetry = useUpdateTelemetrySettingsMutation()

  const draft = useSettingsDraft<TelemetryForm>({
    data: telemetryQ.data,
    initial: TELEMETRY_DEFAULT,
    normalize: normalizeTelemetry,
    hydrate: hydrateTelemetry,
    onSave: (value) => updateTelemetry.mutateAsync(value),
    successTitle: 'Telemetry settings saved',
  })
  const maxDays = telemetryQ.data?.max_retention_days ?? FALLBACK_MAX_DAYS
  const defaultDays = telemetryQ.data?.default_retention_days ?? TELEMETRY_DEFAULT.retention_days
  const envPinned = telemetryQ.data?.env_pinned ?? false
  const effective = telemetryQ.data?.effective_days
  const days = draft.value.retention_days
  const daysError = !Number.isFinite(days) || days < 1 || days > maxDays
    ? `A whole number from 1 to ${maxDays}.`
    : null

  return (
    <SettingsPage
      title="Telemetry"
      description="Traces and metrics for every turn are stored on this computer and power the Telemetry view. Nothing is sent anywhere."
      draft={{ ...draft, canSave: draft.canSave && !daysError && !envPinned }}
      loading={telemetryQ.isLoading}
      error={telemetryQ.error}
    >
      <PanelSection title="Retention" flush>
        <PanelRow
          label="Keep telemetry for"
          htmlFor="telemetry-retention-days"
          description={
            envPinned
              ? `The server sets this with OPENAGENTD_OTEL_SPAN_RETENTION_DAYS or OPENAGENTD_OTEL_METRIC_RETENTION_DAYS${effective ? `: traces ${effective.spans} days, metrics ${effective.metrics} days` : ''}. Remove the variable to change it here.`
              : `Older traces and metrics are deleted daily, and right away when you save. Spend and turn history older than this is gone from the Telemetry view. Default ${defaultDays} days.`
          }
          error={daysError}
        >
          <div className="flex items-center gap-2">
            <Input
              id="telemetry-retention-days"
              type="number"
              min={1}
              max={maxDays}
              aria-label="Days to keep telemetry"
              disabled={envPinned}
              value={envPinned && effective ? String(effective.spans) : Number.isFinite(days) ? String(days) : ''}
              onChange={(e) => draft.patch({ retention_days: parseInt(e.target.value, 10) })}
              className="h-9 w-24 font-mono"
            />
            <span className="text-xs text-(--color-text-2)">days</span>
          </div>
        </PanelRow>
      </PanelSection>
    </SettingsPage>
  )
}

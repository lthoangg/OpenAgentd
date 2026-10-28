/**
 * Settings → Telemetry — how many days local traces and metrics are kept.
 * A daily sweep deletes older files; saving a new value sweeps right away.
 * 0 keeps telemetry forever.
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
  const days = draft.value.retention_days
  const daysError = !Number.isFinite(days) || days < 0 || days > maxDays
    ? `A whole number from 0 to ${maxDays}.`
    : null
  const keepForever = days === 0

  return (
    <SettingsPage
      title="Telemetry"
      description="Traces and metrics for every turn are stored on this computer and power the Telemetry view. Nothing is sent anywhere."
      draft={{ ...draft, canSave: draft.canSave && !daysError }}
      loading={telemetryQ.isLoading}
      error={telemetryQ.error}
    >
      <PanelSection title="Retention" flush>
        <PanelRow
          label="Keep telemetry for"
          htmlFor="telemetry-retention-days"
          description={
            keepForever
              ? 'Telemetry is kept forever: nothing is deleted automatically, so it keeps using disk space.'
              : `Older traces and metrics are deleted daily, and right away when you save. Spend and turn history older than this is gone from the Telemetry view. 0 keeps telemetry forever. Default ${defaultDays} days.`
          }
          error={daysError}
        >
          <div className="flex items-center gap-2">
            <Input
              id="telemetry-retention-days"
              type="number"
              min={0}
              max={maxDays}
              aria-label="Days to keep telemetry"
              value={Number.isFinite(days) ? String(days) : ''}
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

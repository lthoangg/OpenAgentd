/**
 * Settings → Telemetry — how many days local traces and metrics are kept.
 * A daily sweep deletes older files; saving a new value sweeps right away.
 * "Keep forever" stores 0 (the server's "never delete").
 */
import { useTelemetrySettingsQuery, useUpdateTelemetrySettingsMutation } from '@/queries/useTelemetrySettingsQuery'
import { Input } from '@/components/ui/input'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { Switch } from '@/components/ui/switch'
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
    successTitle: 'Data retention saved',
  })
  const maxDays = telemetryQ.data?.max_retention_days ?? FALLBACK_MAX_DAYS
  const defaultDays = telemetryQ.data?.default_retention_days ?? TELEMETRY_DEFAULT.retention_days
  const days = draft.value.retention_days
  const daysError = !Number.isFinite(days) || days < 0 || days > maxDays
    ? `A whole number from 0 to ${maxDays}.`
    : null
  const keepForever = days === 0
  const savedDays = telemetryQ.data?.retention_days
  // Saving a shorter window deletes the older history right away.
  const deletesHistory = Number.isFinite(days) && days > 0 && savedDays !== undefined && (savedDays === 0 || days < savedDays)

  return (
    <SettingsPage
      title="Data retention"
      description="Traces and metrics for every turn are stored on this computer and power the Usage view. Nothing is sent anywhere."
      draft={{ ...draft, canSave: draft.canSave && !daysError }}
      saveBlockedReason={daysError ? `Fix the number of days to save. ${daysError}` : null}
      confirmSave={{
        when: deletesHistory,
        title: `Delete history older than ${days} days?`,
        description: 'Traces, metrics and spend older than this are deleted as soon as you save, and the Usage view can no longer show them.',
        confirmLabel: 'Delete and save',
      }}
      loading={telemetryQ.isLoading}
      error={telemetryQ.error}
    >
      <PanelSection title="Retention" flush>
        <PanelRow
          label="Keep forever"
          htmlFor="telemetry-keep-forever"
          description={
            keepForever
              ? 'Nothing is deleted automatically, so disk use keeps growing.'
              : 'Off: older history is deleted after the number of days below.'
          }
        >
          <Switch
            id="telemetry-keep-forever"
            aria-label="Keep forever"
            checked={keepForever}
            onCheckedChange={(checked) => draft.patch({ retention_days: checked ? 0 : (savedDays || defaultDays) })}
          />
        </PanelRow>
        <PanelRow
          label="Keep traces and metrics for"
          htmlFor="telemetry-retention-days"
          description={
            keepForever
              ? 'Everything is kept. Turn off Keep forever to set a number of days.'
              : `Older traces and metrics are deleted daily, and right away when you save. Spend and turns older than this disappear from Usage. Default: ${defaultDays} days.`
          }
          error={daysError}
        >
          <div className="flex items-center gap-2">
            <Input
              id="telemetry-retention-days"
              type="number"
              min={0}
              max={maxDays}
              aria-label="Days to keep traces and metrics"
              disabled={keepForever}
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

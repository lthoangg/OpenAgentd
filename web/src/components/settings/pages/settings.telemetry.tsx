/**
 * Settings → Sessions → History: how many days local traces are kept.
 * A daily sweep deletes older files; saving a new value sweeps right away.
 * "Keep forever" stores 0 (the server's "never delete").
 */
import { useState } from 'react'

import { useTelemetrySettingsQuery, useUpdateTelemetrySettingsMutation } from '@/queries/useTelemetrySettingsQuery'
import { Input } from '@/components/ui/input'
import type { SettingsPart } from '@/components/settings/SettingsPartsPage'
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

export function useHistoryPart(): SettingsPart {
  const telemetryQ = useTelemetrySettingsQuery()
  const updateTelemetry = useUpdateTelemetrySettingsMutation()

  const draft = useSettingsDraft<TelemetryForm>({
    data: telemetryQ.data,
    initial: TELEMETRY_DEFAULT,
    normalize: normalizeTelemetry,
    hydrate: hydrateTelemetry,
    onSave: (value) => updateTelemetry.mutateAsync(value),
    successTitle: 'Usage history setting saved',
  })
  const maxDays = telemetryQ.data?.max_retention_days ?? FALLBACK_MAX_DAYS
  const defaultDays = telemetryQ.data?.default_retention_days ?? TELEMETRY_DEFAULT.retention_days
  const days = draft.value.retention_days
  // 0 is how the server stores "forever", and only the switch writes it: a 0
  // typed into the days field is a mistake, not a reason to fold the field away.
  const [typedZero, setTypedZero] = useState(false)
  const zeroTyped = typedZero && draft.dirty && days === 0
  const daysError = !Number.isFinite(days) || days < 0 || days > maxDays || zeroTyped
    ? `A whole number from 1 to ${maxDays}.`
    : null
  const keepForever = days === 0 && !zeroTyped
  const savedDays = telemetryQ.data?.retention_days
  // Saving a shorter window deletes the older history right away.
  const deletesHistory = Number.isFinite(days) && days > 0 && savedDays !== undefined && (savedDays === 0 || days < savedDays)

  return {
    draft: { ...draft, canSave: draft.canSave && !daysError },
    saveBlockedReason: daysError ? `Fix the number of days to save. ${daysError}` : null,
    confirmSave: {
      when: deletesHistory,
      title: `Delete history older than ${days} days?`,
      description: 'Traces and spend older than this are deleted as soon as you save, and the Usage view can no longer show them.',
      confirmLabel: 'Delete and save',
    },
    loading: telemetryQ.isLoading,
    error: telemetryQ.error,
    body: (
      <PanelSection key="history" title="History" flush>
        {/* The switch first: the days row unfolds under it, as every dependent row does. */}
        <PanelRow
          label="Keep usage history forever"
          htmlFor="telemetry-keep-forever"
          description={keepForever ? 'Nothing is deleted, so disk use keeps growing.' : 'It stays on this computer and powers the Usage view.'}
        >
          <Switch
            id="telemetry-keep-forever"
            checked={keepForever}
            onCheckedChange={(checked) => {
              setTypedZero(false)
              draft.patch({ retention_days: checked ? 0 : (savedDays || defaultDays) })
            }}
          />
        </PanelRow>
        {!keepForever && (
          <PanelRow
            label="Keep usage history for"
            htmlFor="telemetry-retention-days"
            inline
            description={`Older history leaves the Usage view. Default ${defaultDays} days.`}
            error={daysError}
          >
            <div className="flex items-center gap-2">
              <Input
                id="telemetry-retention-days"
                type="number"
                min={1}
                max={maxDays}
                aria-label="Days to keep usage history"
                value={Number.isFinite(days) ? String(days) : ''}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10)
                  setTypedZero(next === 0)
                  draft.patch({ retention_days: next })
                }}
                className="h-9 w-20! md:w-24! no-spin text-right font-mono tabular-nums"
              />
              <span className="text-xs text-(--color-text-2)">days</span>
            </div>
          </PanelRow>
        )}
      </PanelSection>
    ),
  }
}

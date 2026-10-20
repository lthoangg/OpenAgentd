/**
 * Settings → Chat titles — name each session from its first message with a
 * small model.
 */
import { useMemo } from 'react'

import {
  useRegistryQuery,
  useTitleGenerationSettingsQuery,
  useUpdateTitleGenerationSettingsMutation,
} from '@/queries'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { ModelCombobox } from '@/components/settings/AgentForm'
import { validateModel } from '@/components/settings/schema'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { TitleGenerationSettings } from '@/api/client'

const TITLES_DEFAULT: TitleGenerationSettings = {
  enabled: true,
  model: '',
  wait_timeout_seconds: 3,
}

function normalizeTitles(form: TitleGenerationSettings): TitleGenerationSettings {
  return {
    enabled: form.enabled,
    model: form.model.trim(),
    wait_timeout_seconds: Math.max(0, form.wait_timeout_seconds),
  }
}

export function TitlesSettingsPage() {
  const titlesQ = useTitleGenerationSettingsQuery()
  const registry = useRegistryQuery()
  const updateTitles = useUpdateTitleGenerationSettingsMutation()

  const textModels = useMemo(
    () => (registry.data?.models ?? []).filter((m) => !m.output_image && !m.output_video),
    [registry.data?.models],
  )

  const draft = useSettingsDraft({
    data: titlesQ.data,
    initial: TITLES_DEFAULT,
    normalize: normalizeTitles,
    onSave: (value) => updateTitles.mutateAsync(value),
    successTitle: 'Title generation settings saved',
  })
  const modelError = validateModel(draft.value.model, { validValues: textModels.map((m) => m.id) })

  return (
    <SettingsPage
      title="Chat titles"
      description="Name each session from its first message."
      draft={{ ...draft, canSave: draft.canSave && !modelError }}
      loading={titlesQ.isLoading}
      error={titlesQ.error}
    >
      <PanelSection title="Titles" flush>
        <PanelRow
          label="Generate titles automatically"
          htmlFor="titles-enabled"
          description="When off, sessions keep their default names."
        >
          <Switch
            id="titles-enabled"
            checked={draft.value.enabled}
            onCheckedChange={(checked) => draft.patch({ enabled: checked })}
          />
        </PanelRow>
        {draft.value.enabled && (
          <>
            <PanelRow label="Model" description="A small, fast model keeps titles quick and cheap." error={modelError}>
              <div className="w-full sm:w-72">
                <ModelCombobox
                  value={draft.value.model}
                  onChange={(val) => draft.patch({ model: val })}
                  options={textModels}
                  invalid={!!modelError}
                />
              </div>
            </PanelRow>
            <PanelRow
              label="Wait timeout"
              htmlFor="titles-wait"
              description="Seconds the first reply waits for its title. 0 doesn't wait."
            >
              <Input
                id="titles-wait"
                type="number"
                min={0}
                aria-label="Wait timeout seconds"
                value={draft.value.wait_timeout_seconds}
                onChange={(e) => draft.patch({ wait_timeout_seconds: parseInt(e.target.value, 10) || 0 })}
                className="h-9 w-24 font-mono"
              />
            </PanelRow>
          </>
        )}
      </PanelSection>
    </SettingsPage>
  )
}

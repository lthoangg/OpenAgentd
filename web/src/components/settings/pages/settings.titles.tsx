/**
 * Settings → Session titles — name each session from its first message with a
 * small model, and optionally rename it from its summary after compaction.
 */
import { useMemo } from 'react'

import {
  useRegistryQuery,
  useTitleGenerationSettingsQuery,
  useUpdateTitleGenerationSettingsMutation,
} from '@/queries'
import { Switch } from '@/components/ui/switch'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { ModelCombobox } from '@/components/settings/AgentForm'
import { validateModel } from '@/components/settings/schema'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { TitleGenerationUpdate } from '@/api/client'

const TITLES_DEFAULT: TitleGenerationUpdate = {
  enabled: true,
  model: '',
  update_after_compaction: false,
}

function normalizeTitles(form: TitleGenerationUpdate): TitleGenerationUpdate {
  return {
    enabled: form.enabled,
    model: form.model.trim(),
    update_after_compaction: form.update_after_compaction,
  }
}

/** Older backends omit `update_after_compaction`. */
function hydrateTitles(data: TitleGenerationUpdate): TitleGenerationUpdate {
  return { enabled: data.enabled, model: data.model, update_after_compaction: data.update_after_compaction ?? false }
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
    hydrate: hydrateTitles,
    onSave: (value) => updateTitles.mutateAsync(value),
    successTitle: 'Session title settings saved',
  })
  const modelError = validateModel(draft.value.model, { validValues: textModels.map((m) => m.id) })

  return (
    <SettingsPage
      title="Session titles"
      description="Name each session from its first message."
      draft={{ ...draft, canSave: draft.canSave && !modelError }}
      loading={titlesQ.isLoading}
      error={titlesQ.error}
    >
      <PanelSection title="Automatic titles" flush>
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
              label="Update title after summarizing"
              htmlFor="titles-after-compaction"
              description="Renames the session from its summary each time earlier messages are summarized. Titles you renamed yourself are kept."
            >
              <Switch
                id="titles-after-compaction"
                checked={draft.value.update_after_compaction}
                onCheckedChange={(checked) => draft.patch({ update_after_compaction: checked })}
              />
            </PanelRow>
          </>
        )}
      </PanelSection>
    </SettingsPage>
  )
}

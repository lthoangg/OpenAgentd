/** /settings/title-generation — edit automatic chat title settings. */
import { useMemo, useState } from 'react'
import { Save, Type } from 'lucide-react'

import {
  useRegistryQuery,
  useTitleGenerationSettingsQuery,
  useUpdateTitleGenerationSettingsMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { ModelCombobox } from '@/components/settings/AgentForm'
import { validateModel } from '@/components/settings/schema'
import type { TitleGenerationSettings } from '@/api/client'

const DEFAULT_FORM: TitleGenerationSettings = {
  enabled: true,
  model: '',
  wait_timeout_seconds: 3,
}

function normalized(form: TitleGenerationSettings): TitleGenerationSettings {
  return {
    enabled: form.enabled,
    model: form.model.trim(),
    wait_timeout_seconds: Math.max(0, form.wait_timeout_seconds),
  }
}

export function TitleGenerationSettingsPage() {
  const { data, isLoading, error } = useTitleGenerationSettingsQuery()
  const updateMut = useUpdateTitleGenerationSettingsMutation()
  const registry = useRegistryQuery()
  const push = useToastStore((s) => s.push)

  const [form, setForm] = useState<TitleGenerationSettings>(DEFAULT_FORM)
  const [sourceRaw, setSourceRaw] = useState<TitleGenerationSettings | null>(null)

  if (data && data !== sourceRaw) {
    setForm(data)
    setSourceRaw(data)
  }

  const dirty = useMemo(() => {
    if (!sourceRaw) return false
    const current = normalized(form)
    const source = normalized(sourceRaw)
    return (
      current.enabled !== source.enabled ||
      current.model !== source.model ||
      current.wait_timeout_seconds !== source.wait_timeout_seconds
    )
  }, [form, sourceRaw])

  const modelOptions = useMemo(
    () => (registry.data?.models ?? []).filter((m) => !m.output_image && !m.output_video),
    [registry.data?.models],
  )
  const validModelIds = useMemo(() => modelOptions.map((m) => m.id), [modelOptions])
  const modelError = validateModel(form.model, { validValues: validModelIds })

  const setField = <K extends keyof TitleGenerationSettings>(
    key: K,
    val: TitleGenerationSettings[K],
  ) => setForm((prev) => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    try {
      const saved = await updateMut.mutateAsync(normalized(form))
      setSourceRaw(saved)
      push({ tone: 'success', title: 'Title generation settings saved' })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-4 select-none">
        <Type size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Title generation</h1>
        {dirty && <span className="text-xs text-(--color-text-subtle)" aria-live="polite">Unsaved</span>}
        <Button size="sm" className="min-h-11 md:min-h-0" onClick={handleSave} disabled={!dirty || !!modelError || updateMut.isPending}>
          <Save size={12} aria-hidden="true" />
          <span>{updateMut.isPending ? 'Saving…' : 'Save'}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Title generation creates short session names after the first user message.
            Choose a small, fast model to keep titles quick and cost-efficient.
          </p>

          {isLoading && <p className="text-xs font-mono text-(--color-text-muted)">Loading…</p>}
          {error && (
            <div className="rounded-md border border-(--color-error)/20 bg-(--color-error-subtle) p-3 text-xs text-(--color-error)">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          {!isLoading && !error && (
            <SettingsSection title="Configuration">
              <div className="space-y-3">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs md:min-h-0 select-none">
                  <Switch checked={form.enabled} onCheckedChange={(checked) => setField('enabled', checked)} />
                  <span className="text-(--color-text) font-medium">Enabled</span>
                </label>

                {form.enabled && (
                  <div className="space-y-3 pt-1">
                    <div className="grid gap-1.5">
                      <label className="text-xs font-medium text-(--color-text-muted)">Model ID</label>
                      <ModelCombobox value={form.model} onChange={(val) => setField('model', val)} options={modelOptions} invalid={!!modelError} />
                      {modelError ? <p className="text-[10px] text-(--color-error) font-mono">{modelError}</p> : null}
                    </div>
                    <div className="grid gap-1.5">
                      <label htmlFor="timeout-field" className="text-xs font-medium text-(--color-text-muted)">Wait timeout seconds</label>
                      <Input id="timeout-field" type="number" min={0} value={form.wait_timeout_seconds} onChange={(e) => setField('wait_timeout_seconds', parseInt(e.target.value) || 0)} className="min-h-11 md:min-h-9 font-mono text-xs" />
                      <p className="text-[10.5px] text-(--color-text-subtle) leading-relaxed">Delay to wait for backend processing before triggering title generation.</p>
                    </div>
                  </div>
                )}
              </div>
            </SettingsSection>
          )}
        </div>
      </div>
    </>
  )
}

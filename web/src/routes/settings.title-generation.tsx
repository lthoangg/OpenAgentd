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

  const modelOptions = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
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
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--bg-page) px-4">
        <Type size={15} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-sm font-semibold text-(--color-text)">Title generation</h1>
        {dirty && <span className="text-xs text-(--color-text-muted)">Unsaved</span>}
        <Button size="sm" className="min-h-11 md:min-h-0" onClick={handleSave} disabled={!dirty || !!modelError || updateMut.isPending}>
          <Save size={12} aria-hidden="true" />
          <span className="hidden sm:inline">{updateMut.isPending ? 'Saving...' : 'Save'}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 p-6">
          <p className="text-sm leading-relaxed text-(--color-text-muted)">
            Title generation creates short session names after the first user message.
            Choose a small, fast model to keep titles quick and cost-efficient.
          </p>

          {isLoading && <p className="text-sm text-(--color-text-muted)">Loading...</p>}
          {error && (
            <p className="text-sm text-(--color-error)">
              {error instanceof Error ? error.message : String(error)}
            </p>
          )}

          {!isLoading && !error && (
            <div className="space-y-5">
              <section className="space-y-3 rounded-xl border border-(--color-border) bg-(--bg-card) p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted)">
                  Status
                </h2>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-(--color-text) md:min-h-0">
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(checked) => setField('enabled', checked)}
                  />
                  Enabled
                </label>
              </section>

              <section className="space-y-3 rounded-xl border border-(--color-border) bg-(--bg-card) p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted)">
                  Model
                </h2>
                <div className="grid gap-1.5">
                  <label htmlFor="title-model" className="text-xs font-medium text-(--color-text-muted)">
                    Model ID
                  </label>
                  <ModelCombobox
                    value={form.model}
                    onChange={(value) => setField('model', value)}
                    options={modelOptions}
                    invalid={!!modelError}
                    placeholder="codex:gpt-5.5-mini"
                  />
                  {modelError ? (
                    <p className="text-[11px] text-(--color-error)">{modelError}</p>
                  ) : (
                    <p className="text-[11px] text-(--color-text-muted)">
                      Leave empty to use the current agent model. Prefer small, low-latency models for this background task.
                    </p>
                  )}
                </div>
              </section>

              <section className="space-y-3 rounded-xl border border-(--color-border) bg-(--bg-card) p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted)">
                  Timing
                </h2>
                <div className="grid gap-1.5">
                  <label htmlFor="title-wait-timeout" className="text-xs font-medium text-(--color-text-muted)">
                    Wait timeout seconds
                  </label>
                  <Input
                    id="title-wait-timeout"
                    type="number"
                    min={0}
                    step={0.5}
                    value={String(form.wait_timeout_seconds)}
                    onChange={(e) => setField('wait_timeout_seconds', Number(e.target.value))}
                    className="min-h-11 font-mono text-sm md:min-h-9"
                  />
                  <p className="text-[11px] text-(--color-text-muted)">
                    Best-effort wait before the final done event. Set to 0 for fully background title updates.
                  </p>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/** /settings/summarization — configure the context-window summarization trigger. */
import { useMemo, useState } from 'react'
import { AlignLeft, Save } from 'lucide-react'

import {
  useSummarizationSettingsQuery,
  useUpdateSummarizationSettingsMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from '@/components/settings/SettingsSection'
import type { SummarizationSettings } from '@/api/client'

const DEFAULT_FORM: SummarizationSettings = {
  prompt_token_threshold: null,
}

function normalized(form: SummarizationSettings): SummarizationSettings {
  return {
    prompt_token_threshold:
      form.prompt_token_threshold !== null && form.prompt_token_threshold > 0
        ? Math.floor(form.prompt_token_threshold)
        : null,
  }
}

export function SummarizationSettingsPage() {
  const { data, isLoading, error } = useSummarizationSettingsQuery()
  const updateMut = useUpdateSummarizationSettingsMutation()
  const push = useToastStore((s) => s.push)

  const [form, setForm] = useState<SummarizationSettings>(DEFAULT_FORM)
  const [sourceRaw, setSourceRaw] = useState<SummarizationSettings | null>(null)

  if (data && data !== sourceRaw) {
    setForm(data)
    setSourceRaw(data)
  }

  /** Raw text value while the user is typing — allows clearing the field. */
  const [rawInput, setRawInput] = useState<string>('')
  const [inputInitialized, setInputInitialized] = useState(false)

  // Sync rawInput once when data first arrives.
  if (data && !inputInitialized) {
    setRawInput(data.prompt_token_threshold !== null ? String(data.prompt_token_threshold) : '')
    setInputInitialized(true)
  }

  const dirty = useMemo(() => {
    if (!sourceRaw) return false
    return normalized(form).prompt_token_threshold !== normalized(sourceRaw).prompt_token_threshold
  }, [form, sourceRaw])

  const thresholdError =
    form.prompt_token_threshold !== null && form.prompt_token_threshold < 1
      ? 'Must be a positive integer or leave empty to use the auto value.'
      : null

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setRawInput(raw)
    if (raw.trim() === '') {
      setForm((prev) => ({ ...prev, prompt_token_threshold: null }))
    } else {
      const parsed = parseInt(raw, 10)
      setForm((prev) => ({ ...prev, prompt_token_threshold: isNaN(parsed) ? null : parsed }))
    }
  }

  const handleSave = async () => {
    try {
      const saved = await updateMut.mutateAsync(normalized(form))
      setSourceRaw(saved)
      setRawInput(saved.prompt_token_threshold !== null ? String(saved.prompt_token_threshold) : '')
      push({ tone: 'success', title: 'Summarization settings saved' })
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
        <AlignLeft size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Summarization</h1>
        {dirty && <span className="text-xs text-(--color-text-subtle)" aria-live="polite">Unsaved</span>}
        <Button
          size="sm"
          className="min-h-11 md:min-h-0"
          onClick={handleSave}
          disabled={!dirty || !!thresholdError || updateMut.isPending}
        >
          <Save size={12} aria-hidden="true" />
          <span>{updateMut.isPending ? 'Saving…' : 'Save'}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Controls when OpenAgentD compacts the conversation history into a rolling summary to keep
            the context window manageable.
          </p>

          {isLoading && <p className="text-xs font-mono text-(--color-text-muted)">Loading…</p>}
          {error && (
            <div className="rounded-md border border-(--color-error)/20 bg-(--color-error-subtle) p-3 text-xs text-(--color-error)">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          {!isLoading && !error && (
            <SettingsSection title="Trigger threshold">
              <div className="space-y-3">
                <div className="grid gap-1.5">
                  <label htmlFor="threshold-field" className="text-xs font-medium text-(--color-text-muted)">
                    Token threshold
                  </label>
                  <Input
                    id="threshold-field"
                    type="number"
                    min={1}
                    step={1000}
                    placeholder="Auto (80% of model context)"
                    value={rawInput}
                    onChange={handleThresholdChange}
                    className="min-h-11 md:min-h-9 font-mono text-xs"
                    aria-describedby="threshold-hint"
                  />
                  {thresholdError ? (
                    <p className="text-[10px] text-(--color-error) font-mono">{thresholdError}</p>
                  ) : (
                    <p id="threshold-hint" className="text-[10.5px] text-(--color-text-subtle) leading-relaxed">
                      Leave empty to use the auto value (80% of the model's context window).
                      Enter a lower number to trigger summarization earlier.
                      Values equal to or above the auto threshold are treated as auto.
                    </p>
                  )}
                </div>
              </div>
            </SettingsSection>
          )}
        </div>
      </div>
    </>
  )
}

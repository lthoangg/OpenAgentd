/**
 * /settings/voice — edit speech.yaml: voice input enable/disable and config.
 *
 * Follows the Dream/Sandbox pattern: local draft state rebased on the server
 * snapshot, dirty flag, Save button. Changes are written to speech.yaml via
 * PUT /api/speech/config and hot-reloaded by the backend on the next request.
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, Mic, Save } from 'lucide-react'
import { Link } from '@tanstack/react-router'

import {
  useSpeechConfigQuery,
  useUpdateSpeechConfigMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { useIsMobile } from '@/hooks/use-mobile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SpeechConfig } from '@/api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoiceForm {
  enabled: boolean
  model: string
  language: string
  max_file_mb: number
}

const DEFAULT_FORM: VoiceForm = {
  enabled: false,
  model: 'local:base',
  language: 'auto',
  max_file_mb: 25,
}

function formFromConfig(cfg: SpeechConfig): VoiceForm {
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    language: cfg.language,
    max_file_mb: cfg.max_file_mb,
  }
}

function configFromForm(form: VoiceForm): SpeechConfig {
  return {
    enabled: form.enabled,
    model: form.model.trim(),
    language: form.language.trim() || 'auto',
    max_file_mb: form.max_file_mb,
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function VoiceSettingsPage() {
  const isMobile = useIsMobile()
  const { data, isLoading, error } = useSpeechConfigQuery()
  const updateMut = useUpdateSpeechConfigMutation()
  const push = useToastStore((s) => s.push)

  const [form, setForm] = useState<VoiceForm>(DEFAULT_FORM)
  const [sourceRaw, setSourceRaw] = useState<SpeechConfig | null>(null)

  // Rebase onto server snapshot (snapshot identity pattern — no useEffect).
  if (data && data !== sourceRaw) {
    setForm(formFromConfig(data))
    setSourceRaw(data)
  }

  const dirty = useMemo(() => {
    if (!sourceRaw) return false
    const src = formFromConfig(sourceRaw)
    return (
      form.enabled !== src.enabled ||
      form.model.trim() !== src.model ||
      (form.language.trim() || 'auto') !== src.language ||
      form.max_file_mb !== src.max_file_mb
    )
  }, [form, sourceRaw])

  const setField = <K extends keyof VoiceForm>(key: K, val: VoiceForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    try {
      const saved = await updateMut.mutateAsync(configFromForm(form))
      setSourceRaw(saved)
      push({ tone: 'success', title: 'Voice config saved' })
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
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        {isMobile && (
          <Link
            to="/settings"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Back to settings"
          >
            <ArrowLeft size={14} />
          </Link>
        )}
        <Mic size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <h1 className="flex-1 truncate text-sm font-semibold">Voice input</h1>
        {dirty && (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Unsaved
          </span>
        )}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || updateMut.isPending}
        >
          <Save size={12} aria-hidden="true" />
          {updateMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 p-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Voice input lets you record from the microphone and insert the
            transcript into the chat input for review before sending.
            Transcription runs locally — no audio leaves your machine.
          </p>

          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}

          {error && (
            <div
              className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive"
              role="alert"
            >
              <span>{error instanceof Error ? error.message : String(error)}</span>
            </div>
          )}

          {!isLoading && !error && (
            <div className="space-y-5">

              {/* ── Enable / disable ───────────────────────────────── */}
              <section className="space-y-3 rounded-xl border border-border p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </h2>

                <label className="flex cursor-pointer items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setField('enabled', e.target.checked)}
                    className="h-4 w-4 rounded border-border accent-foreground"
                  />
                  <span className="text-foreground">Enabled</span>
                </label>
                <p className="text-xs text-muted-foreground">
                  When disabled the mic button in the chat input is shown but inactive.
                  Requires the <code className="rounded bg-muted px-1 font-mono">voice-local</code> extra:{' '}
                  <code className="rounded bg-muted px-1 font-mono">uv sync --extra voice-local</code>
                </p>
              </section>

              {/* ── Model ─────────────────────────────────────────── */}
              <section className="space-y-3 rounded-xl border border-border p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Model
                </h2>

                <div className="grid gap-1.5">
                  <label htmlFor="voice-model" className="text-xs font-medium text-muted-foreground">
                    Model ID
                  </label>
                  <Input
                    id="voice-model"
                    value={form.model}
                    onChange={(e) => setField('model', e.target.value)}
                    placeholder="local:base"
                    className="h-9 font-mono text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Format: <code className="font-mono">provider:name</code>.
                    V1 supports <code className="font-mono">local:base</code>,{' '}
                    <code className="font-mono">local:small</code>, and{' '}
                    <code className="font-mono">local:medium</code> (faster-whisper model sizes).
                  </p>
                </div>
              </section>

              {/* ── Language & limits ─────────────────────────────── */}
              <section className="space-y-3 rounded-xl border border-border p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Transcription
                </h2>

                <div className="grid gap-1.5">
                  <label htmlFor="voice-language" className="text-xs font-medium text-muted-foreground">
                    Language
                  </label>
                  <Input
                    id="voice-language"
                    value={form.language}
                    onChange={(e) => setField('language', e.target.value)}
                    placeholder="auto"
                    className="h-9 font-mono text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    <code className="font-mono">auto</code> lets Whisper detect the language.
                    Use a BCP-47 code to force a specific language —{' '}
                    e.g. <code className="font-mono">en</code>, <code className="font-mono">fr</code>,{' '}
                    <code className="font-mono">ja</code>.
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <label htmlFor="voice-max-mb" className="text-xs font-medium text-muted-foreground">
                    Max upload (MB)
                  </label>
                  <Input
                    id="voice-max-mb"
                    type="number"
                    min={1}
                    max={200}
                    value={form.max_file_mb}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10)
                      if (!isNaN(n) && n > 0) setField('max_file_mb', n)
                    }}
                    className="h-9 w-28 font-mono text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Recordings larger than this are rejected before transcription.
                    A few minutes of compressed WebM audio is typically under 5 MB.
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

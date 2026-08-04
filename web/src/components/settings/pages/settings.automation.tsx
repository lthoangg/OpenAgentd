/**
 * Automation — background model jobs.
 *
 * Merges three sections that used to be separate top-level nav entries:
 * Title generation, Summarization, and Multimodal. They were never really
 * three concepts. Each is the same shape ("which model runs this background
 * job, and with what parameters"), so presenting them as peers of Providers
 * and Sandbox overstated their importance and buried the relationship.
 *
 * Each group keeps its own resource, query, and draft, so a validation error
 * in one does not block saving another. `combineDrafts` gives all three a
 * single save bar.
 */
import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'

import {
  useMultimodalSettingsQuery,
  useRegistryQuery,
  useSummarizationSettingsQuery,
  useTitleGenerationSettingsQuery,
  useUpdateMultimodalSettingsMutation,
  useUpdateSummarizationSettingsMutation,
  useUpdateTitleGenerationSettingsMutation,
} from '@/queries'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingsDisclosure } from '@/components/settings/SettingsDisclosure'
import { SettingsField } from '@/components/settings/SettingsField'
import { ModelCombobox, type ModelOption } from '@/components/settings/AgentForm'
import { validateModel } from '@/components/settings/schema'
import { combineDrafts, useSettingsDraft } from '@/components/settings/useSettingsDraft'
import { TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'
import type {
  MultimodalSettings,
  SummarizationSettings,
  TitleGenerationSettings,
} from '@/api/client'

// ── Option lists ──────────────────────────────────────────────────────────

const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K']
const IMAGE_OPENAI_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp']
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16']
const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k']
const VIDEO_DURATIONS = ['4', '6', '8']
const PROVIDER_DEFAULT = '__provider_default__'

const TITLES_DEFAULT: TitleGenerationSettings = {
  enabled: true,
  model: '',
  wait_timeout_seconds: 3,
}

const SUMMARIZATION_DEFAULT: SummarizationSettings = {
  prompt_token_threshold: null,
}

const MULTIMODAL_DEFAULT: MultimodalSettings = {
  image: {
    model: 'googlegenai:gemini-3.1-flash-image-preview',
    aspect_ratio: '1:1',
    image_size: '1K',
  },
  video: {
    model: 'googlegenai:veo-3.1-generate-preview',
    aspect_ratio: '16:9',
    resolution: '720p',
    duration_seconds: '8',
  },
}

// ── Normalizers ───────────────────────────────────────────────────────────

function normalizeTitles(form: TitleGenerationSettings): TitleGenerationSettings {
  return {
    enabled: form.enabled,
    model: form.model.trim(),
    wait_timeout_seconds: Math.max(0, form.wait_timeout_seconds),
  }
}

function normalizeSummarization(form: SummarizationSettings): SummarizationSettings {
  return {
    prompt_token_threshold:
      form.prompt_token_threshold !== null && form.prompt_token_threshold > 0
        ? Math.floor(form.prompt_token_threshold)
        : null,
  }
}

function normalizeMultimodal(form: MultimodalSettings): MultimodalSettings {
  const image: MultimodalSettings['image'] = {
    ...form.image,
    model: String(form.image.model ?? '').trim(),
    aspect_ratio: String(form.image.aspect_ratio ?? '1:1').trim() || '1:1',
    image_size: String(form.image.image_size ?? '1K').trim() || '1K',
  }
  // Optional keys are dropped entirely when unset so the provider default
  // applies, rather than sending an empty string the backend must interpret.
  for (const key of ['size', 'output_format', 'quality']) {
    const value = form.image[key]
    if (
      value === null ||
      value === undefined ||
      String(value).trim() === '' ||
      value === PROVIDER_DEFAULT
    ) {
      delete image[key]
    } else {
      image[key] = String(value).trim()
    }
  }

  return {
    image,
    video: {
      ...form.video,
      model: String(form.video.model ?? '').trim(),
      aspect_ratio: String(form.video.aspect_ratio ?? '16:9').trim() || '16:9',
      resolution: String(form.video.resolution ?? '720p').trim() || '720p',
      duration_seconds: String(form.video.duration_seconds ?? '8').trim() || '8',
    },
  }
}

function hydrateMultimodal(data: MultimodalSettings): MultimodalSettings {
  return {
    image: { ...MULTIMODAL_DEFAULT.image, ...data.image },
    video: { ...MULTIMODAL_DEFAULT.video, ...data.video },
  }
}

// ── Page ──────────────────────────────────────────────────────────────────

export function AutomationSettingsPage() {
  const titlesQ = useTitleGenerationSettingsQuery()
  const summarizationQ = useSummarizationSettingsQuery()
  const multimodalQ = useMultimodalSettingsQuery()
  const registry = useRegistryQuery()

  const updateTitles = useUpdateTitleGenerationSettingsMutation()
  const updateSummarization = useUpdateSummarizationSettingsMutation()
  const updateMultimodal = useUpdateMultimodalSettingsMutation()

  // ── Model option lists, split by output modality ──
  const allModels = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
  const textModels = useMemo(
    () => allModels.filter((m) => !m.output_image && !m.output_video),
    [allModels],
  )
  const imageModels = useMemo(() => allModels.filter((m) => m.output_image), [allModels])
  const videoModels = useMemo(() => allModels.filter((m) => m.output_video), [allModels])

  // ── Titles ──
  const titlesDraft = useSettingsDraft({
    data: titlesQ.data,
    initial: TITLES_DEFAULT,
    normalize: normalizeTitles,
    onSave: (value) => updateTitles.mutateAsync(value),
    successTitle: 'Title generation settings saved',
  })
  const titlesModelError = validateModel(titlesDraft.value.model, {
    validValues: textModels.map((m) => m.id),
  })

  // ── Summarization ──
  const summarizationDraft = useSettingsDraft({
    data: summarizationQ.data,
    initial: SUMMARIZATION_DEFAULT,
    normalize: normalizeSummarization,
    onSave: (value) => updateSummarization.mutateAsync(value),
    successTitle: 'Summarization settings saved',
  })
  const threshold = summarizationDraft.value.prompt_token_threshold
  const thresholdError =
    threshold !== null && threshold < 1
      ? 'Must be a positive integer, or leave empty to use the auto value.'
      : null

  // ── Multimodal ──
  const multimodalDraft = useSettingsDraft({
    data: multimodalQ.data,
    initial: MULTIMODAL_DEFAULT,
    normalize: normalizeMultimodal,
    hydrate: hydrateMultimodal,
    onSave: (value) => updateMultimodal.mutateAsync(value),
    successTitle: 'Multimodal settings saved',
  })
  const mm = multimodalDraft.value
  const setImage = (key: string, value: string) =>
    multimodalDraft.set((prev) => ({ ...prev, image: { ...prev.image, [key]: value } }))
  const setVideo = (key: string, value: string) =>
    multimodalDraft.set((prev) => ({ ...prev, video: { ...prev.video, [key]: value } }))

  const imageModelError = validateModel(String(mm.image.model ?? ''), {
    validValues: imageModels.map((m) => m.id),
  })
  const videoModelError = validateModel(String(mm.video.model ?? ''), {
    validValues: videoModels.map((m) => m.id),
  })

  // ── Aggregate ──
  // Validation is applied here rather than via the hook's `invalid` option
  // because the errors derive from the draft values computed just above.
  const draft = combineDrafts([
    { ...titlesDraft, canSave: titlesDraft.canSave && !titlesModelError },
    { ...summarizationDraft, canSave: summarizationDraft.canSave && !thresholdError },
    {
      ...multimodalDraft,
      canSave: multimodalDraft.canSave && !imageModelError && !videoModelError,
    },
  ])

  const loading = titlesQ.isLoading || summarizationQ.isLoading || multimodalQ.isLoading
  const error = titlesQ.error ?? summarizationQ.error ?? multimodalQ.error

  return (
    <SettingsPage
      title="Automation"
      icon={Sparkles}
      draft={draft}
      loading={loading}
      error={error}
      intro="Background jobs that run alongside your conversations. Each uses its own model so you can keep the cheap work cheap."
    >
      <SettingsDisclosure
        title="Chat titles"
        dirty={titlesDraft.dirty}
        summary={
          titlesDraft.value.enabled
            ? titlesDraft.value.model || 'No model selected'
            : 'Off'
        }
      >
        <div className="space-y-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs select-none md:min-h-0">
            <Switch
              checked={titlesDraft.value.enabled}
              onCheckedChange={(checked) => titlesDraft.patch({ enabled: checked })}
            />
            <span className={TEXT.label}>Generate titles automatically</span>
          </label>
          <p className={TEXT.hint}>
            Names each session from its first message. Pick a small, fast model to
            keep titles quick and cheap.
          </p>

          {titlesDraft.value.enabled && (
            <div className="grid gap-3 pt-1 sm:grid-cols-2">
              <SettingsField label="Model" error={titlesModelError}>
                <ModelCombobox
                  value={titlesDraft.value.model}
                  onChange={(val) => titlesDraft.patch({ model: val })}
                  options={textModels}
                  invalid={!!titlesModelError}
                />
              </SettingsField>
              <SettingsField
                label="Wait timeout"
                hint="Seconds to wait for backend processing before generating."
              >
                <Input
                  type="number"
                  min={0}
                  aria-label="Wait timeout seconds"
                  value={titlesDraft.value.wait_timeout_seconds}
                  onChange={(e) =>
                    titlesDraft.patch({
                      wait_timeout_seconds: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  className="min-h-11 font-mono md:min-h-9"
                />
              </SettingsField>
            </div>
          )}
        </div>
      </SettingsDisclosure>

      <SettingsDisclosure
        title="Summarization"
        dirty={summarizationDraft.dirty}
        summary={threshold === null ? 'Auto' : `${threshold.toLocaleString()} tokens`}
      >
        <SettingsField
          label="Token threshold"
          error={thresholdError}
          hint="Leave empty to compact at 80% of the model's context window. A lower number summarizes earlier. Values at or above the auto threshold are treated as auto."
        >
          <Input
            type="number"
            min={1}
            step={1000}
            placeholder="Auto (80% of model context)"
            aria-label="Token threshold"
            value={threshold === null ? '' : String(threshold)}
            onChange={(e) => {
              const raw = e.target.value
              const parsed = parseInt(raw, 10)
              summarizationDraft.patch({
                prompt_token_threshold:
                  raw.trim() === '' || Number.isNaN(parsed) ? null : parsed,
              })
            }}
            className="min-h-11 max-w-xs font-mono md:min-h-9"
          />
        </SettingsField>
      </SettingsDisclosure>

      <SettingsDisclosure
        title="Image and video"
        dirty={multimodalDraft.dirty}
        summary={`${String(mm.image.image_size)} image, ${String(mm.video.resolution)} video`}
      >
        <div className="space-y-4">
          <div>
            <p className={cn('mb-2', TEXT.label)}>Image generation</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsField label="Model" error={imageModelError}>
                <ModelCombobox
                  value={String(mm.image.model ?? '')}
                  onChange={(value) => setImage('model', value)}
                  options={imageModels as ModelOption[]}
                  invalid={!!imageModelError}
                  placeholder="Search model…"
                  ariaLabel="Image model"
                />
              </SettingsField>
              <ListField
                label="Aspect ratio"
                value={String(mm.image.aspect_ratio ?? '')}
                onChange={(v) => setImage('aspect_ratio', v)}
                options={IMAGE_ASPECT_RATIOS}
              />
              <ListField
                label="Image size"
                value={String(mm.image.image_size ?? '')}
                onChange={(v) => setImage('image_size', v)}
                options={IMAGE_SIZES}
              />
              <ListField
                label="OpenAI size"
                value={optionalValue(mm.image.size)}
                onChange={(v) => setImage('size', optionalSettingValue(v))}
                options={IMAGE_OPENAI_SIZES}
                optional
              />
              <ListField
                label="Output format"
                value={optionalValue(mm.image.output_format)}
                onChange={(v) => setImage('output_format', optionalSettingValue(v))}
                options={IMAGE_OUTPUT_FORMATS}
                optional
              />
              <ListField
                label="Quality"
                value={optionalValue(mm.image.quality)}
                onChange={(v) => setImage('quality', optionalSettingValue(v))}
                options={IMAGE_QUALITIES}
                optional
              />
            </div>
          </div>

          <div className="border-t border-(--color-border) pt-4">
            <p className={cn('mb-2', TEXT.label)}>Video generation</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsField label="Model" error={videoModelError}>
                <ModelCombobox
                  value={String(mm.video.model ?? '')}
                  onChange={(value) => setVideo('model', value)}
                  options={videoModels as ModelOption[]}
                  invalid={!!videoModelError}
                  placeholder="Search model…"
                  ariaLabel="Video model"
                />
              </SettingsField>
              <ListField
                label="Aspect ratio"
                value={String(mm.video.aspect_ratio ?? '')}
                onChange={(v) => setVideo('aspect_ratio', v)}
                options={VIDEO_ASPECT_RATIOS}
              />
              <ListField
                label="Resolution"
                value={String(mm.video.resolution ?? '')}
                onChange={(v) => setVideo('resolution', v)}
                options={VIDEO_RESOLUTIONS}
              />
              <ListField
                label="Duration"
                value={String(mm.video.duration_seconds ?? '')}
                onChange={(v) => setVideo('duration_seconds', v)}
                options={VIDEO_DURATIONS}
              />
            </div>
          </div>
        </div>
      </SettingsDisclosure>
    </SettingsPage>
  )
}

// ── Local controls ────────────────────────────────────────────────────────

function ListField({
  label,
  value,
  onChange,
  options,
  optional,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
  optional?: boolean
}) {
  return (
    <SettingsField label={label}>
      <Dropdown
        value={value}
        onValueChange={(next) => next && onChange(next)}
        trigger={label}
        className="min-h-11 w-full font-mono md:min-h-9"
      >
        {optional ? <DropdownItem value={PROVIDER_DEFAULT}>Provider default</DropdownItem> : null}
        {options.map((option) => (
          <DropdownItem key={option} value={option} className="font-mono">
            {option}
          </DropdownItem>
        ))}
      </Dropdown>
    </SettingsField>
  )
}

function optionalValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return PROVIDER_DEFAULT
  return String(value)
}

function optionalSettingValue(value: string): string {
  return value === PROVIDER_DEFAULT ? '' : value
}

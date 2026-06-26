/** /settings/multimodal — edit image/video generation defaults. */
import { useMemo, useState } from 'react'
import { Image as ImageIcon, Save } from 'lucide-react'

import {
  useMultimodalSettingsQuery,
  useRegistryQuery,
  useUpdateMultimodalSettingsMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { validateModel } from '@/components/settings/schema'
import type { MultimodalSettings } from '@/api/client'
import type { ModelOption } from '@/components/settings/AgentForm'

const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K']
const IMAGE_OPENAI_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp']
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16']
const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k']
const VIDEO_DURATIONS = ['4', '6', '8']
const PROVIDER_DEFAULT = '__provider_default__'

const DEFAULT_FORM: MultimodalSettings = {
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

function normalized(form: MultimodalSettings): MultimodalSettings {
  const image: MultimodalSettings['image'] = {
    ...form.image,
    model: String(form.image.model ?? '').trim(),
    aspect_ratio: String(form.image.aspect_ratio ?? '1:1').trim() || '1:1',
    image_size: String(form.image.image_size ?? '1K').trim() || '1K',
  }
  for (const key of ['size', 'output_format', 'quality']) {
    const value = form.image[key]
    if (value === null || value === undefined || String(value).trim() === '' || value === PROVIDER_DEFAULT) {
      delete image[key]
    } else {
      image[key] = String(value).trim()
    }
  }

  return {
    image: {
      ...image,
    },
    video: {
      ...form.video,
      model: String(form.video.model ?? '').trim(),
      aspect_ratio: String(form.video.aspect_ratio ?? '16:9').trim() || '16:9',
      resolution: String(form.video.resolution ?? '720p').trim() || '720p',
      duration_seconds: String(form.video.duration_seconds ?? '8').trim() || '8',
    },
  }
}

export function MultimodalSettingsPage() {
  const { data, isLoading, error } = useMultimodalSettingsQuery()
  const updateMut = useUpdateMultimodalSettingsMutation()
  const registry = useRegistryQuery()
  const push = useToastStore((s) => s.push)

  const [form, setForm] = useState<MultimodalSettings>(DEFAULT_FORM)
  const [sourceRaw, setSourceRaw] = useState<MultimodalSettings | null>(null)

  if (data && data !== sourceRaw) {
    setForm({
      image: { ...DEFAULT_FORM.image, ...data.image },
      video: { ...DEFAULT_FORM.video, ...data.video },
    })
    setSourceRaw(data)
  }

  const modelOptions = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
  const imageModelOptions = useMemo(
    () => modelOptions.filter((model) => model.output_image),
    [modelOptions],
  )
  const videoModelOptions = useMemo(
    () => modelOptions.filter((model) => model.output_video),
    [modelOptions],
  )
  const imageModelIds = useMemo(() => imageModelOptions.map((m) => m.id), [imageModelOptions])
  const videoModelIds = useMemo(() => videoModelOptions.map((m) => m.id), [videoModelOptions])
  const imageModelError = validateModel(String(form.image.model ?? ''), { required: true, validValues: imageModelIds })
  const videoModelError = validateModel(String(form.video.model ?? ''), { required: true, validValues: videoModelIds })
  const imageAspectError = listError(String(form.image.aspect_ratio ?? ''), IMAGE_ASPECT_RATIOS)
  const imageSizeError = listError(String(form.image.image_size ?? ''), IMAGE_SIZES)
  const imageOpenAiSizeError = optionalListError(form.image.size, IMAGE_OPENAI_SIZES)
  const imageOutputFormatError = optionalListError(form.image.output_format, IMAGE_OUTPUT_FORMATS)
  const imageQualityError = optionalListError(form.image.quality, IMAGE_QUALITIES)
  const videoAspectError = listError(String(form.video.aspect_ratio ?? ''), VIDEO_ASPECT_RATIOS)
  const videoResolutionError = listError(String(form.video.resolution ?? ''), VIDEO_RESOLUTIONS)
  const videoDurationError = listError(String(form.video.duration_seconds ?? ''), VIDEO_DURATIONS)
  const hasError = !!(
    imageModelError ||
    videoModelError ||
    imageAspectError ||
    imageSizeError ||
    imageOpenAiSizeError ||
    imageOutputFormatError ||
    imageQualityError ||
    videoAspectError ||
    videoResolutionError ||
    videoDurationError
  )

  const dirty = useMemo(() => {
    if (!sourceRaw) return false
    return JSON.stringify(normalized(form)) !== JSON.stringify(normalized({
      image: { ...DEFAULT_FORM.image, ...sourceRaw.image },
      video: { ...DEFAULT_FORM.video, ...sourceRaw.video },
    }))
  }, [form, sourceRaw])

  const setImage = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, image: { ...prev.image, [key]: value } }))
  const setVideo = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, video: { ...prev.video, [key]: value } }))

  const handleSave = async () => {
    try {
      const saved = await updateMut.mutateAsync(normalized(form))
      setSourceRaw(saved)
      push({ tone: 'success', title: 'Multimodal settings saved' })
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
        <ImageIcon size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Multimodal</h1>
        {dirty && <span className="text-xs text-(--color-text-subtle)" aria-live="polite">Unsaved</span>}
        <Button size="sm" className="min-h-11 md:min-h-0" onClick={handleSave} disabled={!dirty || hasError || updateMut.isPending}>
          <Save size={12} aria-hidden="true" />
          <span>{updateMut.isPending ? 'Saving…' : 'Save'}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Configure default models and options for image and video generation tools.
          </p>

          {isLoading && <p className="text-xs font-mono text-(--color-text-muted)">Loading…</p>}
          {error && <p className="text-xs text-(--color-error)">{error instanceof Error ? error.message : String(error)}</p>}

          {!isLoading && !error && (
            <div className="space-y-4">
              <section className="space-y-3.5 rounded-md border border-(--color-border) bg-(--bg-card) p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted) border-b border-(--color-border)/60 pb-1.5 mb-3">
                  Image
                </h2>

                <div className="grid gap-3 sm:grid-cols-2">
                  <ModelField value={String(form.image.model ?? '')} onChange={(value) => setImage('model', value)} options={imageModelOptions} error={imageModelError} />
                  <ListField label="Aspect ratio" value={String(form.image.aspect_ratio ?? '')} onChange={(value) => setImage('aspect_ratio', value)} options={IMAGE_ASPECT_RATIOS} error={imageAspectError} />
                  <ListField label="Image size" value={String(form.image.image_size ?? '')} onChange={(value) => setImage('image_size', value)} options={IMAGE_SIZES} error={imageSizeError} />
                  <ListField label="OpenAI size" value={optionalValue(form.image.size)} onChange={(value) => setImage('size', optionalSettingValue(value))} options={IMAGE_OPENAI_SIZES} error={imageOpenAiSizeError} optional />
                  <ListField label="Output format" value={optionalValue(form.image.output_format)} onChange={(value) => setImage('output_format', optionalSettingValue(value))} options={IMAGE_OUTPUT_FORMATS} error={imageOutputFormatError} optional />
                  <ListField label="Quality" value={optionalValue(form.image.quality)} onChange={(value) => setImage('quality', optionalSettingValue(value))} options={IMAGE_QUALITIES} error={imageQualityError} optional />
                </div>
              </section>

              <section className="space-y-3.5 rounded-md border border-(--color-border) bg-(--bg-card) p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted) border-b border-(--color-border)/60 pb-1.5 mb-3">
                  Video
                </h2>

                <div className="grid gap-3 sm:grid-cols-2">
                  <ModelField value={String(form.video.model ?? '')} onChange={(value) => setVideo('model', value)} options={videoModelOptions} error={videoModelError} />
                  <ListField label="Aspect ratio" value={String(form.video.aspect_ratio ?? '')} onChange={(value) => setVideo('aspect_ratio', value)} options={VIDEO_ASPECT_RATIOS} error={videoAspectError} />
                  <ListField label="Resolution" value={String(form.video.resolution ?? '')} onChange={(value) => setVideo('resolution', value)} options={VIDEO_RESOLUTIONS} error={videoResolutionError} />
                  <ListField label="Duration seconds" value={String(form.video.duration_seconds ?? '')} onChange={(value) => setVideo('duration_seconds', value)} options={VIDEO_DURATIONS} error={videoDurationError} />
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function ModelField({ value, onChange, options, error }: {
  value: string
  onChange: (value: string) => void
  options: ModelOption[]
  error: string | null
}) {
  return (
    <div className="grid gap-1">
      <label className="text-[11px] font-medium text-(--color-text-muted)">Model ID</label>
      <Dropdown
        value={value}
        onValueChange={(next) => next && onChange(next)}
        trigger="Choose a model"
        className="min-h-11 w-full font-mono md:min-h-9"
        aria-invalid={!!error || undefined}
      >
        {options.map((option) => (
          <DropdownItem key={option.id} value={option.id} className="font-mono">
            {option.id}
          </DropdownItem>
        ))}
      </Dropdown>
      {error ? <p className="text-[10px] text-(--color-error) font-mono">{error}</p> : null}
    </div>
  )
}

function ListField({ label, value, onChange, options, error, optional }: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
  error: string | null
  optional?: boolean
}) {
  return (
    <div className="grid gap-1">
      <label className="text-[11px] font-medium text-(--color-text-muted)">{label}</label>
      <Dropdown
        value={value}
        onValueChange={(next) => next && onChange(next)}
        trigger={label}
        className="min-h-11 w-full font-mono md:min-h-9"
        aria-invalid={!!error || undefined}
      >
        {optional ? (
          <DropdownItem value={PROVIDER_DEFAULT}>Provider default</DropdownItem>
        ) : null}
        {options.map((option) => (
          <DropdownItem key={option} value={option} className="font-mono">
            {option}
          </DropdownItem>
        ))}
      </Dropdown>
      {error ? <p className="text-[10px] text-(--color-error) font-mono">{error}</p> : null}
    </div>
  )
}

function listError(value: string, options: string[]): string | null {
  if (!options.includes(value)) return 'Choose a value from the list.'
  return null
}

function optionalListError(value: unknown, options: string[]): string | null {
  if (value === null || value === undefined || value === '' || value === PROVIDER_DEFAULT) return null
  if (!options.includes(String(value))) return 'Choose a value from the list.'
  return null
}

function optionalValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return PROVIDER_DEFAULT
  return String(value)
}

function optionalSettingValue(value: string): string {
  return value === PROVIDER_DEFAULT ? '' : value
}

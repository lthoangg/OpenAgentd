/**
 * Settings → Media generation — the model and defaults the image and video
 * tools use.
 */
import { useMemo } from 'react'

import {
  useMultimodalSettingsQuery,
  useRegistryQuery,
  useUpdateMultimodalSettingsMutation,
} from '@/queries'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { ModelCombobox, type ModelOption } from '@/components/settings/AgentForm'
import { validateModel } from '@/components/settings/schema'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { MultimodalSettings } from '@/api/client'

const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K']
const IMAGE_OPENAI_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp']
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high']
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16']
const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k']
/** Display words for raw option values; the value saved stays the raw one. */
const OPTION_LABEL: Record<string, string> = { '4k': '4K', '0.5K': '0.5K (512 px)', '1K': '1K (1024 px)', '2K': '2K (2048 px)', '4K': '4K (4096 px)' }
const VIDEO_DURATIONS = ['4', '6', '8']
const PROVIDER_DEFAULT = '__provider_default__'

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

export function MediaSettingsPage() {
  const multimodalQ = useMultimodalSettingsQuery()
  const registry = useRegistryQuery()
  const updateMultimodal = useUpdateMultimodalSettingsMutation()

  const allModels = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
  const imageModels = useMemo(() => allModels.filter((m) => m.output_image), [allModels])
  const videoModels = useMemo(() => allModels.filter((m) => m.output_video), [allModels])

  const draft = useSettingsDraft({
    data: multimodalQ.data,
    initial: MULTIMODAL_DEFAULT,
    normalize: normalizeMultimodal,
    hydrate: hydrateMultimodal,
    onSave: (value) => updateMultimodal.mutateAsync(value),
    successTitle: 'Image and video settings saved',
  })
  const mm = draft.value
  const setImage = (key: string, value: string) =>
    draft.set((prev) => ({ ...prev, image: { ...prev.image, [key]: value } }))
  const setVideo = (key: string, value: string) =>
    draft.set((prev) => ({ ...prev, video: { ...prev.video, [key]: value } }))

  const imageModelError = validateModel(String(mm.image.model ?? ''), {
    validValues: imageModels.map((m) => m.id),
  })
  const videoModelError = validateModel(String(mm.video.model ?? ''), {
    validValues: videoModels.map((m) => m.id),
  })

  return (
    <SettingsPage
      title="Image and video"
      description="The models and defaults agents use when they create images and videos."
      draft={{ ...draft, canSave: draft.canSave && !imageModelError && !videoModelError }}
      saveBlockedReason={imageModelError ? 'Pick an image model from the list to save.' : videoModelError ? 'Pick a video model from the list to save.' : null}
      loading={multimodalQ.isLoading}
      error={multimodalQ.error}
    >
      <PanelSection title="Image generation" flush>
        <PanelRow label="Model" error={imageModelError}>
          <div className="w-full sm:w-72">
            <ModelCombobox
              value={String(mm.image.model ?? '')}
              onChange={(value) => setImage('model', value)}
              options={imageModels as ModelOption[]}
              invalid={!!imageModelError}
              placeholder="Search model…"
              ariaLabel="Image model"
            />
          </div>
        </PanelRow>
        <ListRow label="Aspect ratio" value={String(mm.image.aspect_ratio ?? '')} onChange={(v) => setImage('aspect_ratio', v)} options={IMAGE_ASPECT_RATIOS} />
        <ListRow label="Size (other models)" value={String(mm.image.image_size ?? '')} onChange={(v) => setImage('image_size', v)} options={IMAGE_SIZES} />
        <ListRow
          label="Size (OpenAI models)"
          description="OpenAI image models use this size instead."
          value={optionalValue(mm.image.size)}
          onChange={(v) => setImage('size', optionalSettingValue(v))}
          options={IMAGE_OPENAI_SIZES}
          optional
        />
        <ListRow
          label="Output format"
          value={optionalValue(mm.image.output_format)}
          onChange={(v) => setImage('output_format', optionalSettingValue(v))}
          options={IMAGE_OUTPUT_FORMATS}
          optional
        />
        <ListRow
          label="Quality"
          value={optionalValue(mm.image.quality)}
          onChange={(v) => setImage('quality', optionalSettingValue(v))}
          options={IMAGE_QUALITIES}
          optional
        />
      </PanelSection>

      <PanelSection title="Video generation" flush>
        <PanelRow label="Model" error={videoModelError}>
          <div className="w-full sm:w-72">
            <ModelCombobox
              value={String(mm.video.model ?? '')}
              onChange={(value) => setVideo('model', value)}
              options={videoModels as ModelOption[]}
              invalid={!!videoModelError}
              placeholder="Search model…"
              ariaLabel="Video model"
            />
          </div>
        </PanelRow>
        <ListRow label="Aspect ratio" value={String(mm.video.aspect_ratio ?? '')} onChange={(v) => setVideo('aspect_ratio', v)} options={VIDEO_ASPECT_RATIOS} />
        <ListRow label="Resolution" value={String(mm.video.resolution ?? '')} onChange={(v) => setVideo('resolution', v)} options={VIDEO_RESOLUTIONS} />
        <ListRow
          label="Duration"
          description="In seconds."
          value={String(mm.video.duration_seconds ?? '')}
          onChange={(v) => setVideo('duration_seconds', v)}
          options={VIDEO_DURATIONS}
        />
      </PanelSection>
    </SettingsPage>
  )
}

/** A row whose control picks one value from a short list. */
function ListRow({
  label,
  description,
  value,
  onChange,
  options,
  optional,
}: {
  label: string
  description?: string
  value: string
  onChange: (value: string) => void
  options: string[]
  optional?: boolean
}) {
  return (
    <PanelRow label={label} description={description}>
      <Dropdown
        value={value}
        onValueChange={(next) => next && onChange(next)}
        trigger={label}
        className="h-9 w-full sm:w-44"
      >
        {[
          ...(optional ? [<DropdownItem key={PROVIDER_DEFAULT} value={PROVIDER_DEFAULT}>Provider default</DropdownItem>] : []),
          ...options.map((option) => (
            <DropdownItem key={option} value={option}>
              {OPTION_LABEL[option] ?? option}
            </DropdownItem>
          )),
        ]}
      </Dropdown>
    </PanelRow>
  )
}

function optionalValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return PROVIDER_DEFAULT
  return String(value)
}

function optionalSettingValue(value: string): string {
  return value === PROVIDER_DEFAULT ? '' : value
}

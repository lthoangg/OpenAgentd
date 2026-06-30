import { useEffect, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'

import { useRegistryQuery } from '@/queries'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ModelCombobox } from '@/components/settings/AgentForm/ModelCombobox'

const THINKING_LEVELS = [
  { value: '', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const FALLBACK_THINKING_LEVEL_VALUES = ['none']

export function SessionModelSettings({
  defaultModel,
  sessionModel,
  sessionThinkingLevel,
  sessionFastMode,
  onChange,
}: {
  defaultModel: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  sessionFastMode: boolean
  onChange: (model: string | null, thinkingLevel: string | null, fastMode: boolean) => void
}) {
  const registry = useRegistryQuery()
  const [draftModel, setDraftModel] = useState(sessionModel ?? defaultModel ?? '')
  const [draftThinkingLevel, setDraftThinkingLevel] = useState(sessionThinkingLevel ?? '')
  const [draftFastMode, setDraftFastMode] = useState(sessionFastMode)

  // When the saved values change externally (e.g. after the user saves from
  // this very panel, or after loadSession restores a different session model),
  // sync the draft — but only if the draft hasn't diverged from the previous
  // saved snapshot (i.e. the user hasn't started editing a new draft).
  const prevSavedRef = useRef({ model: sessionModel, thinkingLevel: sessionThinkingLevel, fastMode: sessionFastMode })
  useEffect(() => {
    const prev = prevSavedRef.current
    const modelChanged = sessionModel !== prev.model
    const thinkingChanged = sessionThinkingLevel !== prev.thinkingLevel
    const fastChanged = sessionFastMode !== prev.fastMode
    if (!modelChanged && !thinkingChanged && !fastChanged) return

    // Only reset a field if the draft is still tracking the old saved value
    // (i.e. the user hasn't touched it since the last external update).
    setDraftModel((d) => (d === (prev.model ?? defaultModel ?? '') ? (sessionModel ?? defaultModel ?? '') : d))
    setDraftThinkingLevel((d) => (d === (prev.thinkingLevel ?? '') ? (sessionThinkingLevel ?? '') : d))
    setDraftFastMode((d) => (d === prev.fastMode ? sessionFastMode : d))
    prevSavedRef.current = { model: sessionModel, thinkingLevel: sessionThinkingLevel, fastMode: sessionFastMode }
  }, [sessionModel, sessionThinkingLevel, sessionFastMode, defaultModel])

  const modelOptions = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
  // Keep the saved/draft model visible in the list even if it isn't (yet) in
  // the registry — mirrors the Settings/Agents combobox so a previously saved
  // model id never silently disappears from the picker.
  const currentModelOptions = useMemo(() => {
    const filtered = modelOptions.filter((m) => !m.output_image && !m.output_video)
    const id = draftModel.trim()
    if (!id) return filtered
    if (filtered.some((model) => model.id === id)) return filtered
    // Keep a previously-saved model visible even if it isn't in the registry yet.
    const colonIdx = id.indexOf(':')
    const provider = colonIdx >= 0 ? id.slice(0, colonIdx) : id
    const model = colonIdx >= 0 ? id.slice(colonIdx + 1) : id
    return [...filtered, { id, provider, model, vision: false }]
  }, [draftModel, modelOptions])
  const savedModel = sessionModel ?? defaultModel ?? ''
  const savedThinkingLevel = sessionThinkingLevel ?? ''
  const savedFastMode = sessionFastMode
  const dirty =
    draftModel !== savedModel ||
    draftThinkingLevel !== savedThinkingLevel ||
    draftFastMode !== savedFastMode
  const trimmedDraftModel = draftModel.trim()
  const effectiveDraftModel = trimmedDraftModel || defaultModel || ''
  const effectiveModelEntry = modelOptions.find((model) => model.id === effectiveDraftModel)
  const thinkingLevelOptions = useMemo(() => {
    const modelThinkingLevels = effectiveModelEntry?.thinking_levels ?? []

    const toLabel = (value: string) =>
      value.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')

    const allowedLevels = modelThinkingLevels.length > 0 ? modelThinkingLevels : FALLBACK_THINKING_LEVEL_VALUES
    const normalizedLevels = allowedLevels.filter((value) => value !== '__none__')

    const fallbackByValue = new Map(THINKING_LEVELS.map((level) => [level.value, level.label]))
    const options = [
      THINKING_LEVELS[0],
      ...normalizedLevels.map((value) => ({
        value,
        label: fallbackByValue.get(value) ?? toLabel(value),
      })),
    ]

    if (draftThinkingLevel && !options.some((level) => level.value === draftThinkingLevel)) {
      options.push({ value: draftThinkingLevel, label: toLabel(draftThinkingLevel) })
    }
    return options
  }, [draftThinkingLevel, effectiveModelEntry])
  const fastModeAvailable = effectiveDraftModel.startsWith('codex:')
  const validModelIds = useMemo(
    () => new Set(modelOptions.map((model) => model.id)),
    [modelOptions],
  )
  const modelValid =
    trimmedDraftModel === '' ||
    trimmedDraftModel === defaultModel ||
    validModelIds.has(trimmedDraftModel)

  const selectThinkingLevel = (level: string) => {
    setDraftThinkingLevel(level)
  }

  const selectedThinkingLabel = thinkingLevelOptions.find((level) => level.value === draftThinkingLevel)?.label ?? 'Default'

  return (
    <section className="shrink-0 border-b border-(--color-border) bg-(--bg-page) px-3 py-3 sm:px-5 sm:py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-(--color-text)">Current session</h3>
          <p className="mt-0.5 text-xs text-(--color-text-muted)">
            Saved changes apply to the lead agent on the next message in this chat session.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="default"
            size="xs"
            className="h-8 px-2 text-[10.5px]"
            disabled={!dirty}
            onClick={() => {
              setDraftModel(savedModel)
              setDraftThinkingLevel(savedThinkingLevel)
              setDraftFastMode(savedFastMode)
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            className="h-8 px-2 text-[10.5px]"
            disabled={!dirty || !modelValid}
            onClick={() => {
              onChange(
                trimmedDraftModel && trimmedDraftModel !== defaultModel ? trimmedDraftModel : null,
                draftThinkingLevel || null,
                fastModeAvailable && draftFastMode,
              )
            }}
          >
            Save
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_minmax(14rem,0.8fr)]">
        <label className="min-w-0 text-xs text-(--color-text-muted)">
          <span className="mb-1 block font-medium text-(--color-text-2)">Model</span>
          <ModelCombobox
            value={draftModel}
            options={currentModelOptions}
            onChange={setDraftModel}
            invalid={!modelValid}
            placeholder="Search session model…"
            ariaLabel="Search session model"
          />
          {!modelValid && (
            <span className="mt-1 block text-[11px] text-(--color-error)">
              Choose a model from the list.
            </span>
          )}
          {modelValid && !trimmedDraftModel && defaultModel && (
            <span className="mt-1 block text-[11px] text-(--color-text-muted)">
              Using default: {defaultModel}
            </span>
          )}
        </label>
        <label className="text-xs text-(--color-text-muted)">
          <span className="mb-1 block font-medium text-(--color-text-2)">Thinking</span>
          <Dropdown
            value={draftThinkingLevel}
            onValueChange={selectThinkingLevel}
            trigger={selectedThinkingLabel}
            className="min-h-10 w-full md:min-h-9"
            aria-label="Thinking level"
          >
            {thinkingLevelOptions.map((level) => (
              <DropdownItem key={level.value} value={level.value}>
                {level.label}
              </DropdownItem>
            ))}
          </Dropdown>
        </label>
        <label className="min-w-0 text-xs text-(--color-text-muted)">
          <span className="mb-1 flex items-center gap-1 font-medium text-(--color-text-2)">
            Fast mode
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 cursor-help text-(--color-text-muted) transition-colors hover:text-(--color-text-2)">
                    <Info size={12} aria-label="About Fast mode" />
                  </span>
                }
              />
              <TooltipContent>
                {fastModeAvailable
                  ? 'Use Codex Fast mode for messages in this session.'
                  : 'Available when the session model is codex:*.'}
              </TooltipContent>
            </Tooltip>
          </span>
          <div
            className={`flex min-h-10 w-full items-center gap-2 rounded-sm border border-(--color-border) bg-(--bg-input) px-2.5 py-1.5 transition-colors md:min-h-9 ${
              fastModeAvailable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
            }`}
          >
            <Checkbox
              checked={fastModeAvailable && draftFastMode}
              disabled={!fastModeAvailable}
              onCheckedChange={setDraftFastMode}
              aria-label="Fast mode"
            />
            <span className="truncate text-xs text-(--color-text-2)">
              {fastModeAvailable && draftFastMode ? 'Enabled' : 'Off'}
            </span>
          </div>
        </label>
      </div>
    </section>
  )
}

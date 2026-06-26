import { useMemo, useState } from 'react'
import fuzzysort from 'fuzzysort'

import { useRegistryQuery } from '@/queries'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'

const THINKING_LEVELS = [
  { value: '', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

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
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [activeModelIndex, setActiveModelIndex] = useState(0)

  const modelOptions = useMemo(() => registry.data?.models ?? [], [registry.data?.models])
  const visibleModelOptions = useMemo(() => {
    const q = draftModel.trim()
    if (!q) return modelOptions.slice(0, 40)
    return fuzzysort.go(q, modelOptions, { key: 'id', limit: 40 }).map((result) => result.obj)
  }, [modelOptions, draftModel])
  const savedModel = sessionModel ?? defaultModel ?? ''
  const savedThinkingLevel = sessionThinkingLevel ?? ''
  const savedFastMode = sessionFastMode
  const dirty =
    draftModel !== savedModel ||
    draftThinkingLevel !== savedThinkingLevel ||
    draftFastMode !== savedFastMode
  const trimmedDraftModel = draftModel.trim()
  const effectiveDraftModel = trimmedDraftModel || defaultModel || ''
  const fastModeAvailable = effectiveDraftModel.startsWith('codex:')
  const validModelIds = useMemo(
    () => new Set(modelOptions.map((model) => model.id)),
    [modelOptions],
  )
  const modelValid =
    trimmedDraftModel === '' ||
    trimmedDraftModel === defaultModel ||
    validModelIds.has(trimmedDraftModel)
  const pickerOptions = useMemo(
    () => visibleModelOptions.map((model) => ({ id: model.id, label: model.id })),
    [visibleModelOptions],
  )

  const selectModel = (modelId: string) => {
    setDraftModel(modelId)
    setModelPickerOpen(false)
  }

  const selectThinkingLevel = (level: string) => {
    setDraftThinkingLevel(level)
  }

  const selectedThinkingLabel = THINKING_LEVELS.find((level) => level.value === draftThinkingLevel)?.label ?? 'Default'

  return (
    <section className="shrink-0 border-b border-(--color-border) bg-(--bg-page) px-5 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
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
            size="sm"
            disabled={!dirty}
            onClick={() => {
              setDraftModel(savedModel)
              setDraftThinkingLevel(savedThinkingLevel)
              setDraftFastMode(savedFastMode)
              setModelPickerOpen(false)
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || !modelValid}
            onClick={() => {
              onChange(
                trimmedDraftModel && trimmedDraftModel !== defaultModel ? trimmedDraftModel : null,
                draftThinkingLevel || null,
                fastModeAvailable && draftFastMode,
              )
              setModelPickerOpen(false)
            }}
          >
            Save
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="w-80 max-w-full text-xs text-(--color-text-muted)">
          <span className="mb-1 block font-medium text-(--color-text-2)">Model</span>
          <div className="relative">
              <input
                value={draftModel}
                onChange={(e) => {
                  setDraftModel(e.target.value)
                  setModelPickerOpen(true)
                  setActiveModelIndex(0)
                }}
                className="w-full rounded border border-(--color-border) bg-(--bg-card) px-2.5 py-1.5 font-mono text-xs text-(--color-text) outline-none transition-colors focus:border-(--focus-ring) focus:ring-2 focus:ring-(--focus-ring)/30"
                aria-label="Search session model"
                role="combobox"
                aria-expanded={modelPickerOpen}
                aria-invalid={!modelValid}
                onFocus={() => setModelPickerOpen(true)}
                onBlur={() => window.setTimeout(() => setModelPickerOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setModelPickerOpen(true)
                    setActiveModelIndex((index) => Math.min(index + 1, pickerOptions.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActiveModelIndex((index) => Math.max(index - 1, 0))
                  } else if (e.key === 'Enter' && modelPickerOpen) {
                    e.preventDefault()
                    const option = pickerOptions[activeModelIndex]
                    if (option) selectModel(option.id)
                  } else if (e.key === 'Escape') {
                    setModelPickerOpen(false)
                  }
                }}
              />
            {modelPickerOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-[min(34rem,calc(90vw-3rem))] rounded border border-(--color-border) bg-(--bg-card) p-1 shadow-md">
                <div className="max-h-64 overflow-auto">
                {pickerOptions.map((model, index) => (
                  <button
                    type="button"
                    key={`${index}:${model.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveModelIndex(index)}
                    onClick={() => selectModel(model.id)}
                    className={`flex w-full items-center rounded px-2 py-1 text-left font-mono text-xs transition-colors cursor-pointer ${index === activeModelIndex ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-2) hover:bg-(--bg-key)'}`}
                  >
                    {model.label}
                  </button>
                ))}
                </div>
              </div>
            )}
          </div>
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
            className="w-44 max-w-full"
            aria-label="Thinking level"
          >
            {THINKING_LEVELS.map((level) => (
              <DropdownItem key={level.value} value={level.value}>
                {level.label}
              </DropdownItem>
            ))}
          </Dropdown>
        </label>
        <label className="flex min-w-56 max-w-full items-start gap-2 rounded-md border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)">
          <input
            type="checkbox"
            checked={fastModeAvailable && draftFastMode}
            disabled={!fastModeAvailable}
            onChange={(e) => setDraftFastMode(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-(--color-accent)"
          />
          <span>
            <span className="block font-medium text-(--color-text-2)">Fast mode</span>
            <span className="mt-0.5 block text-[11px]">
              {fastModeAvailable
                ? 'Use Codex Fast mode for messages in this session.'
                : 'Available when the session model is codex:*.'}
            </span>
          </span>
        </label>
      </div>
    </section>
  )
}

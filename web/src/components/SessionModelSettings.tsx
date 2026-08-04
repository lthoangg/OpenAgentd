/**
 * SessionModelSettings — model and thinking level for this session.
 *
 * Applies instantly. There is no Apply button because the override only takes
 * effect on the next message anyway, so a confirm step bought nothing while
 * costing a draft state that had to be reconciled against props on every
 * external change.
 *
 * Two cases are deliberately *not* committed, because the combobox pushes every
 * keystroke upstream (it drives its own validation):
 *   - a half-typed id, until it resolves to a real registry entry;
 *   - an empty field, which means "I'm about to type", not "use the default".
 *     Committing empty would re-derive the default and refill the input under
 *     the user's cursor. To fall back to the default, pick it from the list
 *     like any other model.
 *
 * Everything else renders straight from props, the single source of truth.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye } from 'lucide-react'

import { useRegistryQuery } from '@/queries'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { ModelCombobox } from '@/components/settings/AgentForm/ModelCombobox'
import type { ModelCatalogEntry } from '@/api/types'

const DEFAULT_LEVEL_LABEL = 'Default'
const KNOWN_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/** Models with no declared levels still accept `none`. */
const FALLBACK_THINKING_LEVEL_VALUES = ['none']

function levelLabel(value: string): string {
  return (
    KNOWN_LEVEL_LABELS[value] ??
    value.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  )
}

/** Thinking levels a model actually supports. `__none__` is an internal
 *  registry marker, never a user-selectable level. */
function levelsFor(entry: ModelCatalogEntry | undefined): string[] {
  const declared = entry?.thinking_levels ?? []
  const allowed = declared.length > 0 ? declared : FALLBACK_THINKING_LEVEL_VALUES
  return allowed.filter((value) => value !== '__none__')
}

export function SessionModelSettings({
  defaultModel,
  sessionModel,
  sessionThinkingLevel,
  onChange,
  modelInputRef,
}: {
  defaultModel: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  onChange: (model: string | null, thinkingLevel: string | null) => void
  /** Exposed so the panel can make this the overlay's initial focus. */
  modelInputRef?: React.RefObject<HTMLInputElement | null>
}) {
  const registry = useRegistryQuery()
  const modelOptions = useMemo(() => registry.data?.models ?? [], [registry.data?.models])

  // Fall back to a local ref when the parent doesn't need one.
  const localModelInputRef = useRef<HTMLInputElement | null>(null)
  const inputRef = modelInputRef ?? localModelInputRef

  const savedModel = sessionModel ?? defaultModel ?? ''

  // The combobox text is the only local state: it has to hold values that
  // aren't committable yet (mid-typing). External changes are adopted with the
  // derived-state pattern rather than an effect (React docs: "You might not
  // need an effect").
  const [modelText, setModelText] = useState(savedModel)
  const [lastSavedModel, setLastSavedModel] = useState(savedModel)
  if (savedModel !== lastSavedModel) {
    setLastSavedModel(savedModel)
    setModelText(savedModel)
  }

  // Keep a previously saved model visible even if it isn't (yet) in the
  // registry, but never turn an in-progress search query into an option.
  const currentModelOptions = useMemo(() => {
    const filtered = modelOptions.filter((m) => !m.output_image && !m.output_video)
    const id = savedModel.trim()
    if (!id) return filtered
    if (filtered.some((model) => model.id === id)) return filtered
    const colonIdx = id.indexOf(':')
    const provider = colonIdx >= 0 ? id.slice(0, colonIdx) : id
    const model = colonIdx >= 0 ? id.slice(colonIdx + 1) : id
    return [...filtered, { id, provider, model, vision: false }]
  }, [modelOptions, savedModel])

  const validModelIds = useMemo(
    () => new Set(modelOptions.map((model) => model.id)),
    [modelOptions],
  )
  /** A real model the session can be pinned to. Empty is not committable: see
   *  the module docstring. */
  const isCommittable = (id: string) => id !== '' && (id === defaultModel || validModelIds.has(id))
  /** Empty is not an *error* either — it's just incomplete. */
  const isAcceptable = (id: string) => id === '' || isCommittable(id)

  const trimmedModel = modelText.trim()
  const modelValid = isAcceptable(trimmedModel)
  const effectiveModel = trimmedModel || defaultModel || ''
  const effectiveEntry = modelOptions.find((model) => model.id === effectiveModel)

  const thinkingLevel = sessionThinkingLevel ?? ''
  const supportedLevels = levelsFor(effectiveEntry)

  const thinkingOptions = useMemo(() => {
    const options = [
      { value: '', label: DEFAULT_LEVEL_LABEL },
      ...supportedLevels.map((value) => ({ value, label: levelLabel(value) })),
    ]
    // A restored session may hold a level this model no longer lists; keep it
    // visible so the dropdown doesn't silently misreport what is active.
    if (thinkingLevel && !options.some((level) => level.value === thinkingLevel)) {
      options.push({ value: thinkingLevel, label: levelLabel(thinkingLevel) })
    }
    return options
  }, [supportedLevels, thinkingLevel])

  /** Normalise and push upstream. An override equal to the agent default is
   *  stored as `null` so the session doesn't pin a value it didn't choose. */
  const commit = (model: string, level: string) => {
    const id = model.trim()
    onChange(id && id !== defaultModel ? id : null, level || null)
  }

  const selectModel = (next: string) => {
    setModelText(next)
    const id = next.trim()
    if (!isCommittable(id)) return
    // Carry the thinking level across only if the incoming model supports it,
    // in the same commit — otherwise the session would briefly hold a
    // combination the model can't serve.
    const nextEntry = modelOptions.find((m) => m.id === id)
    const nextLevels = levelsFor(nextEntry)
    commit(id, thinkingLevel && nextLevels.includes(thinkingLevel) ? thinkingLevel : '')
  }

  // A session restored from disk can carry a level the current model doesn't
  // support (the model changed underneath it). Drop it once the registry is
  // loaded enough to judge. Committing null stops this from re-firing.
  useEffect(() => {
    if (!registry.data?.models || !modelValid) return
    if (thinkingLevel && !supportedLevels.includes(thinkingLevel)) {
      // Commit the *saved* model, not the draft text: the user may have the
      // field cleared or half-typed, and this effect is only about the level.
      commit(sessionModel ?? '', '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry.data?.models, modelValid, thinkingLevel, supportedLevels])

  const selectedThinkingLabel =
    thinkingOptions.find((level) => level.value === thinkingLevel)?.label ?? DEFAULT_LEVEL_LABEL

  return (
    <div className="shrink-0 px-3 py-3 sm:px-5 sm:py-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        {/* Not a <label>: the caption is decorative (the combobox and dropdown
            carry their own aria-labels) and wrapping a <button> in a <label>
            makes the label's contents the button's accessible name. */}
        <div className="min-w-0 text-xs text-(--color-text-muted)">
          {/* Fixed-height caption row: the Vision chip is taller than bare
              label text (border + padding), and letting it grow this row
              pushes the input below the Thinking control next to it. */}
          <span className="mb-1 flex h-4 items-center gap-1.5 font-medium leading-none text-(--color-text-2)">
            Model
            {effectiveEntry?.vision && (
              <span
                className="flex h-4 items-center gap-1 rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 text-[10px] font-normal leading-none text-(--color-text-muted)"
                title="Accepts image input"
              >
                <Eye size={10} aria-hidden />
                Vision
              </span>
            )}
          </span>
          <ModelCombobox
            value={modelText}
            options={currentModelOptions}
            onChange={selectModel}
            invalid={!modelValid}
            placeholder="Search session model…"
            ariaLabel="Search session model"
            inputRef={inputRef}
            // This field takes focus when the panel opens; auto-opening the
            // list would then hide the rest of the panel behind it.
            openOnFocus={false}
          />
          {!modelValid && (
            <span className="mt-1 block text-[11px] text-(--color-error)">
              Choose a model from the list.
            </span>
          )}
        </div>

        <div className="text-xs text-(--color-text-muted)">
          {/* Same fixed height as the Model caption so both controls share a
              top edge. */}
          <span className="mb-1 flex h-4 items-center font-medium leading-none text-(--color-text-2)">
            Thinking
          </span>
          <Dropdown
            value={thinkingLevel}
            // The level applies to whatever model is saved; the draft text may
            // be mid-edit, so never commit it from here.
            onValueChange={(level) => commit(sessionModel ?? '', level)}
            trigger={selectedThinkingLabel}
            // Matches ModelCombobox's input height (min-h-11 md:min-h-9) so the
            // two controls are the same size, not just the same top edge.
            className="min-h-11 w-full md:min-h-9"
            aria-label="Thinking level"
          >
            {thinkingOptions.map((level) => (
              <DropdownItem key={level.value} value={level.value}>
                {level.label}
              </DropdownItem>
            ))}
          </Dropdown>
        </div>
      </div>
    </div>
  )
}

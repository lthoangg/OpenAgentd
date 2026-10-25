import { useMemo } from 'react'

import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { MultiSelect, type MultiSelectOption } from '../MultiSelect'
import { Field } from '@/components/ui/field'
import { type AgentFrontmatter } from '../frontmatter'
import { validateDescription, validateModel } from '../schema'
import { ModelCombobox, type ModelOption } from './ModelCombobox'

const FALLBACK_THINKING_LEVELS = ['none']

export function ParseErrorBanner({
  message,
  onSwitchToRaw,
}: {
  message: string
  onSwitchToRaw: () => void
}) {
  return (
    <Callout
      tone="error"
      title="Parse error"
      action={
        <Button size="xs" variant="default" className="min-h-9 md:min-h-0" onClick={onSwitchToRaw}>
          Open raw
        </Button>
      }
    >
      {message}
    </Callout>
  )
}

// ── Form mode ───────────────────────────────────────────────────────────────

/**
 * The Form-mode UI, organised into Cards so each concern has a clear title
 * and the form scans top-to-bottom: who → what model → behaviour → tools
 * & skills → system prompt.
 */
export function FormFields({
  fm,
  body,
  disabled,
  toolOptions,
  modelOptions,
  effectiveTools,
  defaultPrompt,
  updateFromForm,
}: {
  fm: AgentFrontmatter
  body: string
  disabled?: boolean
  toolOptions: MultiSelectOption[]
  modelOptions: (ModelOption & { thinking_levels?: string[] })[]
  effectiveTools?: string[]
  defaultPrompt?: string
  updateFromForm: (next: AgentFrontmatter, nextBody: string) => void
}) {
  const isLead = fm.name === 'code' || fm.role === 'lead'
  const hasBuiltInProfile = isLead

  // Per-field errors computed fresh from zod on render. For the scalar
  // string fields we validate whenever the value is non-empty; empty is
  // handled by the caller's full-form check before save.
  const descriptionError = validateDescription(fm.description ?? '')
  const currentModelOptions = useMemo(() => {
    const filtered = modelOptions.filter((m) => !m.output_image && !m.output_video)
    const byId = new Map(filtered.map((model) => [model.id, model]))
    const withCurrent = [...filtered]
    const id = fm.model
    if (id && !byId.has(id) && id.includes(':')) {
      const [provider, model] = id.split(':', 2)
      withCurrent.push({ id, provider, model, vision: false })
    }
    return withCurrent
  }, [fm.model, modelOptions])
  const validModelIds = useMemo(
    () => currentModelOptions.map((m) => m.id),
    [currentModelOptions],
  )
  const modelError = validateModel(fm.model ?? '', {
    required: true,
    validValues: validModelIds,
  })
  // Derive thinking levels from the selected model's registry entry.
  // Fall back to the conservative list when the model isn't in the registry yet
  // (e.g. placeholder entries from the providers list or an unknown model).
  const thinkingLevels = useMemo(() => {
    const entry = currentModelOptions.find((m) => m.id === fm.model)
    const levels = entry?.thinking_levels
    return levels && levels.length > 0 ? levels : FALLBACK_THINKING_LEVELS
  }, [currentModelOptions, fm.model])

  const implicitToolNames = new Set(['skill', 'todo', 'schedule', 'note', 'plan', 'submit_plan', 'todo_manage', 'schedule_task'])

  // For the lead agent (code), core tools and implicit tools are built in.
  // For member agents, only the tools explicitly granted in frontmatter are active.
  const builtInTools = isLead
    ? (effectiveTools ?? []).filter((tool) => !(fm.tools ?? []).includes(tool))
    : []
  const extraToolOptions = isLead
    ? toolOptions.filter((option) => !builtInTools.includes(option.value) && !implicitToolNames.has(option.value))
    : toolOptions.filter((option) => !implicitToolNames.has(option.value))

  return (
    <div className="flex flex-col gap-8">
      {hasBuiltInProfile && (
        <Callout title="Built-in OpenAgentd profile">
          Defaults come from OpenAgentd. Add your own instructions in a global or workspace AGENTS.md.
        </Callout>
      )}

      {/* Identity ─────────────────────────────────────────────── */}
      <PanelSection title="Identity" description="Who this agent is and what it is for.">
        <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
          <Field
            label="Description"
            error={descriptionError}
            className="md:col-span-2"
            hint="One-line summary shown in the agent registry."
          >
            <Input
              type="text"
              className="min-h-9"
              autoCapitalize="sentences"
              autoCorrect="on"
              value={fm.description ?? ''}
              onChange={(e) =>
                updateFromForm({ ...fm, description: e.target.value || null }, body)
              }
              disabled={disabled}
              placeholder="Coordinates work and breaks tasks into focused steps."
              aria-invalid={!!descriptionError || undefined}
            />
          </Field>
        </div>
      </PanelSection>

      {/* Model & behaviour ─────────────────────────────────────── */}
      <PanelSection title="Model & behaviour" description="Which model runs this agent, and how deeply it reasons.">
        <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
          <Field label="Model" required error={modelError} className="md:col-span-2">
            <ModelCombobox
              value={fm.model ?? ''}
              options={currentModelOptions}
              onChange={(v) => {
                const nextFm = { ...fm, model: v }
                const isModelValid = v === '' || validModelIds.includes(v)
                if (isModelValid) {
                  const entry = currentModelOptions.find((m) => m.id === v)
                  const allowedLevels = entry?.thinking_levels && entry.thinking_levels.length > 0
                    ? entry.thinking_levels
                    : FALLBACK_THINKING_LEVELS
                  if (nextFm.thinking_level && !allowedLevels.includes(nextFm.thinking_level)) {
                    nextFm.thinking_level = null
                  }
                }
                updateFromForm(nextFm, body)
              }}
              disabled={disabled}
              invalid={!!modelError}
              placeholder="Type to search models…"
            />
          </Field>

          <Field label="Thinking level" hint="How much hidden reasoning the model may use.">
            <Dropdown
              value={fm.thinking_level ?? '__none__'}
              onValueChange={(v) => {
                if (v == null) return
                updateFromForm({ ...fm, thinking_level: v === '__none__' ? null : v }, body)
              }}
              trigger="Thinking level"
              className="min-h-9 w-full"
              disabled={disabled}
            >
              <DropdownItem value="__none__">(default)</DropdownItem>
              {thinkingLevels.map((lvl) => (
                <DropdownItem key={lvl} value={lvl}>{lvl}</DropdownItem>
              ))}
            </Dropdown>
          </Field>
        </div>
      </PanelSection>

      {/* Capabilities ──────────────────────────────────────────── */}
      <PanelSection
        title="Capabilities"
        description={isLead ? 'Extra tools and skills on top of the built-in profile.' : 'The tools this agent may use.'}
      >
        <div className="flex flex-col gap-5">
          <Field
            label="Tools"
            hint={
              builtInTools.length > 0
                ? `${(fm.tools ?? []).length} extra selected. Built-in tools are always included.`
                : `${(fm.tools ?? []).length} selected of ${extraToolOptions.length} available.`
            }
          >
            {builtInTools.length > 0 && (
              <CapabilityChips label="Built-in tools" values={builtInTools} />
            )}
            <MultiSelect
              options={extraToolOptions}
              value={fm.tools ?? []}
              onChange={(v) => updateFromForm({ ...fm, tools: v }, body)}
              placeholder="Pick extra tools this agent may invoke…"
              selectedLabel="Selected tools"
            />
          </Field>

        </div>
      </PanelSection>

      {/* System prompt ─────────────────────────────────────────── */}
      <PanelSection
        title="System prompt"
        description={isLead ? 'Custom instructions for the lead agent.' : "Instructions that define this agent's behavior."}
      >
        <div className="flex flex-col gap-3">
          {isLead && !body.trim() && (
            <div className="flex items-center justify-between text-xs text-(--color-text-muted)">
              <span>Using built-in system prompt. Edit below to override.</span>
              {defaultPrompt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="min-h-9 md:min-h-0"
                  onClick={() => updateFromForm(fm, defaultPrompt)}
                  disabled={disabled}
                >
                  Load default prompt
                </Button>
              )}
            </div>
          )}
          <Textarea
            value={body}
            onChange={(e) => updateFromForm(fm, e.target.value)}
            disabled={disabled}
            rows={14}
            placeholder={defaultPrompt || 'You are …'}
            className="min-h-72 font-mono text-[13px] leading-relaxed"
            aria-label="System prompt"
          />
        </div>
      </PanelSection>
    </div>
  )
}


// ── Field wrapper ───────────────────────────────────────────────────────────

function CapabilityChips({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-sm border border-(--color-border) bg-(--bg-key)/30 px-3 py-2.5">
      <p className="mb-1.5 label-caps text-(--color-text-muted) select-none">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  )
}

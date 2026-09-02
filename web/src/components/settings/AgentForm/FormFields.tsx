import { useMemo } from 'react'
import { AlertCircle } from 'lucide-react'

import { SectionCard, SectionCardHeader, SectionCardRows } from '@/components/ui/section-card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { MultiSelect, type MultiSelectOption } from '../MultiSelect'
import { SettingsField } from '../SettingsField'
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
    <div className="flex items-start gap-2 rounded-sm border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error)">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">Parse error</p>
        <p className="mt-0.5 opacity-90">{message}</p>
      </div>
      <Button size="xs" variant="default" className="min-h-11 md:min-h-0" onClick={onSwitchToRaw}>
        Open raw
      </Button>
    </div>
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
  mcpOptions,
  modelOptions,
  effectiveTools,
  updateFromForm,
}: {
  fm: AgentFrontmatter
  body: string
  disabled?: boolean
  toolOptions: MultiSelectOption[]
  mcpOptions: MultiSelectOption[]
  modelOptions: (ModelOption & { thinking_levels?: string[] })[]
  effectiveTools?: string[]
  updateFromForm: (next: AgentFrontmatter, nextBody: string) => void
}) {
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

  const hasBuiltInProfile = true
  const implicitToolNames = new Set(['skill', 'todo_manage', 'schedule_task', 'note'])
  const builtInTools = (effectiveTools ?? []).filter(
    (tool) => implicitToolNames.has(tool) || hasBuiltInProfile,
  ).filter((tool) => !(fm.tools ?? []).includes(tool))
  const extraToolOptions = (hasBuiltInProfile
    ? toolOptions.filter((option) => !builtInTools.includes(option.value))
    : toolOptions
  ).filter((option) => !implicitToolNames.has(option.value))

  return (
    <div className="flex flex-col gap-4">
      {hasBuiltInProfile && (
        <div className="rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2.5 text-xs text-(--color-text-muted)">
          <p className="font-semibold text-(--color-text)">Built-in OpenAgentd profile</p>
          <p className="mt-1 leading-relaxed">
            OpenAgentd provides the default description, tools, skills, and prompt in code. Values saved here are additive overrides, so versioned built-ins can improve without overwriting your file.
          </p>
        </div>
      )}

      {/* Identity ─────────────────────────────────────────────── */}
      <SectionCard>
        <SectionCardHeader>Identity — who is this agent and what is its role?</SectionCardHeader>
        <SectionCardRows>
        <div className="px-3 py-3 grid gap-3 md:grid-cols-2">
          <SettingsField
            label="Description"
            error={descriptionError}
            className="md:col-span-2"
            hint="One-line summary shown in the agent registry."
          >
            <Input
              type="text"
              className="min-h-11 md:min-h-9"
              value={fm.description ?? ''}
              onChange={(e) =>
                updateFromForm({ ...fm, description: e.target.value || null }, body)
              }
              disabled={disabled}
              placeholder="Coordinates work and breaks tasks into focused steps."
              aria-invalid={!!descriptionError || undefined}
            />
          </SettingsField>
        </div>
        </SectionCardRows>
      </SectionCard>

      {/* Model & behaviour ─────────────────────────────────────── */}
      <SectionCard>
        <SectionCardHeader>Model &amp; behaviour — provider, reasoning depth</SectionCardHeader>
        <SectionCardRows>
        <div className="px-3 py-3 grid gap-3 md:grid-cols-2">
          <SettingsField label="Model" required error={modelError} className="md:col-span-2">
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
          </SettingsField>

          <SettingsField label="Thinking level" hint="How much hidden reasoning the model may use.">
            <Dropdown
              value={fm.thinking_level ?? '__none__'}
              onValueChange={(v) => {
                if (v == null) return
                updateFromForm({ ...fm, thinking_level: v === '__none__' ? null : v }, body)
              }}
              trigger="Thinking level"
              className="min-h-11 w-full md:min-h-9"
              disabled={disabled}
            >
              <DropdownItem value="__none__">(default)</DropdownItem>
              {thinkingLevels.map((lvl) => (
                <DropdownItem key={lvl} value={lvl}>{lvl}</DropdownItem>
              ))}
            </Dropdown>
          </SettingsField>
        </div>
        </SectionCardRows>
      </SectionCard>

      {/* Capabilities ──────────────────────────────────────────── */}
      <SectionCard>
        <SectionCardHeader>
          {hasBuiltInProfile
            ? 'Capabilities \u2014 extra tools, MCP servers, and skills on top of the built-in profile'
            : 'Capabilities \u2014 tools, MCP servers, and skills'}
        </SectionCardHeader>
        <SectionCardRows>
        <div className="px-3 py-3 flex flex-col gap-4">
          <SettingsField
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
            />
          </SettingsField>

          <SettingsField
            label="MCP servers"
            hint={
              mcpOptions.length === 0
                ? 'No MCP servers configured. Add one under Settings → MCP.'
                : `${(fm.mcp ?? []).length} selected of ${mcpOptions.length} available. Each grants every tool the server exposes.`
            }
          >
            <MultiSelect
              options={mcpOptions}
              value={fm.mcp ?? []}
              onChange={(v) => updateFromForm({ ...fm, mcp: v }, body)}
              placeholder="Pick MCP servers this agent may use…"
              emptyLabel="No matching servers"
            />
          </SettingsField>

        </div>
        </SectionCardRows>
      </SectionCard>

      {/* System prompt ─────────────────────────────────────────── */}
      <SectionCard>
        <SectionCardHeader>
          {hasBuiltInProfile ? 'Extra prompt \u2014 appended after the built-in prompt' : 'System prompt \u2014 instructions at the top of every conversation'}
        </SectionCardHeader>
        <SectionCardRows>
        <div className="px-3 py-3">
          <Textarea
            value={body}
            onChange={(e) => updateFromForm(fm, e.target.value)}
            disabled={disabled}
            rows={14}
            placeholder="You are …"
            className="min-h-72 font-mono text-[13px] leading-relaxed"
          />
        </div>
        </SectionCardRows>
      </SectionCard>
    </div>
  )
}


// ── Field wrapper ───────────────────────────────────────────────────────────

function CapabilityChips({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-xs border border-(--color-border) bg-(--bg-key)/30 px-2.5 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--color-text-muted) select-none">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10.5px] text-(--color-text-muted)"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  )
}

// SettingsField is imported from '../SettingsField' — the local Field was removed.

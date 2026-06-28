import { useMemo, useState } from 'react'
import { AlertCircle } from 'lucide-react'

import { SectionCard, SectionCardHeader, SectionCardRows } from '@/components/ui/section-card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { MultiSelect, type MultiSelectOption } from '../MultiSelect'
import { SettingsField } from '../SettingsField'
import { type AgentFrontmatter } from '../frontmatter'
import {
  parseTemperatureInput,
  validateAgentName,
  validateDescription,
  validateModel,
} from '../schema'
import { ModelCombobox } from './ModelCombobox'
import { isBuiltInProfile } from './utils'

const THINKING_LEVELS: Array<{ value: string; label: string }> = [
  { value: '__none__', label: '(default)' },
  { value: 'none', label: 'none' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]

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
  isNew,
  toolOptions,
  skillOptions,
  mcpOptions,
  modelOptions,
  agentPath,
  effectiveTools,
  updateFromForm,
}: {
  fm: AgentFrontmatter
  body: string
  disabled?: boolean
  isNew?: boolean
  toolOptions: MultiSelectOption[]
  skillOptions: MultiSelectOption[]
  mcpOptions: MultiSelectOption[]
  modelOptions: { id: string; provider: string; model: string; vision: boolean }[]
  agentPath?: string
  effectiveTools?: string[]
  updateFromForm: (next: AgentFrontmatter, nextBody: string) => void
}) {
  // Temperature has a pending state (e.g. "0." while typing) that we need
  // to preserve as a string in local state, independent of the committed
  // `fm.temperature` number. Same approach as React's controlled-input
  // guidance for numeric fields.
  const [tempRaw, setTempRaw] = useState<string>(
    fm.temperature == null ? '' : String(fm.temperature),
  )
  const [tempError, setTempError] = useState<string | null>(null)

  // Per-field errors computed fresh from zod on render. For the scalar
  // string fields we validate whenever the value is non-empty; empty is
  // handled by the caller's full-form check before save.
  const nameError = isNew ? validateAgentName(fm.name) : null
  const descriptionError = validateDescription(fm.description ?? '')
  const currentModelOptions = useMemo(() => {
    const byId = new Map(modelOptions.map((model) => [model.id, model]))
    const withCurrent = [...modelOptions]
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
  const hasBuiltInProfile = isBuiltInProfile(fm.name, fm.role, agentPath)
  const implicitToolNames = new Set(['skill', 'todo_manage', 'schedule_task', 'note'])
  const builtInTools = (effectiveTools ?? []).filter(
    (tool) => implicitToolNames.has(tool) || hasBuiltInProfile,
  ).filter((tool) => !(fm.tools ?? []).includes(tool))
  const extraToolOptions = (hasBuiltInProfile
    ? toolOptions.filter((option) => !builtInTools.includes(option.value))
    : toolOptions
  ).filter((option) => !implicitToolNames.has(option.value))

  const onTempChange = (next: string) => {
    setTempRaw(next)
    const parsed = parseTemperatureInput(next)
    if (parsed.ok === true) {
      setTempError(null)
      updateFromForm({ ...fm, temperature: parsed.value }, body)
    } else if (parsed.ok === 'pending') {
      setTempError(null)
      // Do NOT push to fm yet — keep the last committed value so we don't
      // flip dirty flags spuriously while the user is mid-typing.
    } else {
      setTempError(parsed.error)
    }
  }

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
            label="Name"
            required
            error={nameError}
            hint={
              !isNew
                ? 'Filename stem; cannot be renamed after creation.'
                : 'Letters, digits, ., _, - only.'
            }
          >
            <Input
              type="text"
              value={fm.name}
              onChange={(e) => updateFromForm({ ...fm, name: e.target.value }, body)}
              disabled={disabled || !isNew}
              placeholder="orchestrator"
              aria-invalid={!!nameError || undefined}
              className="min-h-11 font-mono md:min-h-9"
            />
          </SettingsField>

          <SettingsField label="Role" required hint="Exactly one agent in the team must be lead.">
            <Dropdown
              value={fm.role}
              onValueChange={(v) => v && updateFromForm({ ...fm, role: v as 'lead' | 'member' }, body)}
              trigger="Role"
              className="min-h-11 w-full md:min-h-9"
              disabled={disabled}
            >
              <DropdownItem value="lead">Lead</DropdownItem>
              <DropdownItem value="member">Member</DropdownItem>
            </Dropdown>
          </SettingsField>

          <SettingsField
            label="Description"
            error={descriptionError}
            className="md:col-span-2"
            hint="One-line summary shown when the lead browses the team."
          >
            <Input
              type="text"
              className="min-h-11 md:min-h-9"
              value={fm.description ?? ''}
              onChange={(e) =>
                updateFromForm({ ...fm, description: e.target.value || null }, body)
              }
              disabled={disabled}
              placeholder="Coordinates the team. Breaks tasks, delegates to members."
              aria-invalid={!!descriptionError || undefined}
            />
          </SettingsField>
        </div>
        </SectionCardRows>
      </SectionCard>

      {/* Model & behaviour ─────────────────────────────────────── */}
      <SectionCard>
        <SectionCardHeader>Model &amp; behaviour — provider, temperature, reasoning depth</SectionCardHeader>
        <SectionCardRows>
        <div className="px-3 py-3 grid gap-3 md:grid-cols-2">
          <SettingsField label="Model" required error={modelError} className="md:col-span-2">
            <ModelCombobox
              value={fm.model ?? ''}
              options={currentModelOptions}
              onChange={(v) => updateFromForm({ ...fm, model: v }, body)}
              disabled={disabled}
              invalid={!!modelError}
              placeholder="Type to search models…"
            />
          </SettingsField>

          <SettingsField label="Temperature" error={tempError} hint="0 - 2; higher = more random.">
            <Input
              type="text"
              inputMode="decimal"
              value={tempRaw}
              onChange={(e) => onTempChange(e.target.value)}
              disabled={disabled}
              placeholder="0.2"
              aria-invalid={!!tempError || undefined}
              className="min-h-11 font-mono md:min-h-9"
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
              {THINKING_LEVELS.map((lvl) => (
                <DropdownItem key={lvl.value} value={lvl.value}>{lvl.label}</DropdownItem>
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

          <SettingsField
            label="Skills"
            hint={
              hasBuiltInProfile
                ? `${(fm.skills ?? []).length} extra selected. Built-in skills are always included when this profile has them.`
                : `${(fm.skills ?? []).length} selected of ${skillOptions.length} available.`
            }
          >
            <MultiSelect
              options={skillOptions}
              value={fm.skills ?? []}
              onChange={(v) => updateFromForm({ ...fm, skills: v }, body)}
              placeholder="Pick skills the agent can load on demand…"
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

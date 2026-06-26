import { useMemo, useState, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { MultiSelect, type MultiSelectOption } from '../MultiSelect'
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
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]

export function ParseErrorBanner({
  message,
  onSwitchToRaw,
}: {
  message: string
  onSwitchToRaw: () => void
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-(--color-error)/30 bg-(--color-error-subtle) px-3 py-2 text-xs text-(--color-error)">
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
        <div className="rounded-lg border border-(--color-border) bg-(--bg-card) px-4 py-3 text-sm text-(--color-text-muted)">
          <p className="font-medium text-(--color-text)">Built-in OpenAgentd profile</p>
          <p className="mt-1">
            OpenAgentd provides the default description, tools, skills, and prompt in code. Values saved here are additive overrides, so versioned built-ins can improve without overwriting your file.
          </p>
        </div>
      )}

      {/* Identity ─────────────────────────────────────────────── */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>Who is this agent and what is its role?</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field
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
          </Field>

          <Field label="Role" required hint="Exactly one agent in the team must be lead.">
            <Select
              value={fm.role}
              onValueChange={(v) =>
                v && updateFromForm({ ...fm, role: v as 'lead' | 'member' }, body)
              }
              disabled={disabled}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">Lead</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
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
          </Field>
        </CardContent>
      </Card>

      {/* Model & behaviour ─────────────────────────────────────── */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Model &amp; behaviour</CardTitle>
          <CardDescription>
            Which provider, plus sampling temperature and reasoning depth.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Model" required error={modelError} className="md:col-span-2">
            <ModelCombobox
              value={fm.model ?? ''}
              options={currentModelOptions}
              onChange={(v) => updateFromForm({ ...fm, model: v }, body)}
              disabled={disabled}
              invalid={!!modelError}
              placeholder="Type to search models…"
            />
          </Field>

          <Field label="Temperature" error={tempError} hint="0 - 2; higher = more random.">
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
          </Field>

          <Field label="Thinking level" hint="How much hidden reasoning the model may use.">
            <Select
              value={fm.thinking_level ? fm.thinking_level : '__none__'}
              onValueChange={(v) => {
                if (v == null) return
                updateFromForm(
                  { ...fm, thinking_level: v === '__none__' ? null : v },
                  body,
                )
              }}
              disabled={disabled}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THINKING_LEVELS.map((lvl) => (
                  <SelectItem key={lvl.value} value={lvl.value}>
                    {lvl.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {/* Capabilities ──────────────────────────────────────────── */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Capabilities</CardTitle>
          <CardDescription>
            {hasBuiltInProfile
              ? 'Add extra tools, MCP servers, and skills on top of the built-in profile.'
              : 'Tools the agent may invoke, MCP servers it has access to, and skills it can load on demand.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            />
          </Field>

          <Field
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
          </Field>

          <Field
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
          </Field>
        </CardContent>
      </Card>

      {/* System prompt ─────────────────────────────────────────── */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>{hasBuiltInProfile ? 'Extra prompt' : 'System prompt'}</CardTitle>
          <CardDescription>
            {hasBuiltInProfile
              ? 'Additional instructions appended after the built-in prompt.'
              : 'The instructions placed at the top of every conversation with this agent.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={body}
            onChange={(e) => updateFromForm(fm, e.target.value)}
            disabled={disabled}
            rows={14}
            placeholder="You are …"
            className="min-h-72 font-mono text-[13px] leading-relaxed"
          />
        </CardContent>
      </Card>
    </div>
  )
}


// ── Field wrapper ───────────────────────────────────────────────────────────

function CapabilityChips({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-md border border-(--color-border) bg-(--bg-surface) px-3 py-2">
      <p className="mb-1.5 text-[11px] font-medium text-(--color-text-muted)">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="rounded bg-(--bg-key) px-1.5 py-0.5 font-mono text-[11px] text-(--color-text) ring-1 ring-(--color-border)"
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  className,
  children,
  error,
  hint,
}: {
  label: string
  required?: boolean
  className?: string
  children: ReactNode
  /** Zod-sourced error message. When set, rendered in destructive red
   *  under the control; when unset, the hint (if any) is rendered instead. */
  error?: string | null
  /** Helper text shown when there is no error. */
  hint?: string | null
}) {
  // Intentionally a <div>, not a <label>. A <label> wrapper would cause any
  // click inside it to activate the first focusable control in DOM order —
  // in MultiSelect that's the first chip's remove (×) button, which would
  // silently delete a chip when the user clicks empty space in the field.
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-(--color-text)">
        {label}
        {required && <span className="ml-0.5 text-(--color-error)">*</span>}
      </span>
      {children}
      {error ? (
        <p className="text-[11px] text-(--color-error)">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-(--color-text-muted)">{hint}</p>
      ) : null}
    </div>
  )
}

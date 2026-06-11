/**
 * AgentForm — hybrid form for agent .md files.
 *
 * Modes:
 *   - **form**: structured fields for frontmatter + textarea for the
 *     system prompt body. Changes are serialised to canonical YAML on
 *     save. Recommended for most users.
 *   - **raw**: plain textarea with the full .md contents (frontmatter +
 *     body). Power users can hand-edit nested fields the form doesn't
 *     model (e.g. custom hook configuration).
 *
 * Switching form → raw preserves any extra YAML fields the form doesn't
 * know about by re-using the previous raw content whenever possible.
 * Switching raw → form re-parses the current raw text.
 *
 * The mode is a controlled prop so the editor's sticky header (rendered
 * by the parent route) hosts the Form/Raw toggle next to Save — keeping
 * top-of-page real estate consistent across all editor pages.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ChevronDown } from 'lucide-react'
import fuzzysort from 'fuzzysort'

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

import { useAgentFilesQuery, useMcpServersQuery, useRegistryQuery } from '@/queries'
import { MultiSelect, type MultiSelectOption } from './MultiSelect'
import { combine, splitFrontmatter, type AgentFrontmatter } from './frontmatter'
import {
  parseTemperatureInput,
  validateAgentName,
  validateDescription,
  validateModel,
} from './schema'

export interface AgentFormValue {
  /** Current raw .md content (frontmatter + body). Always authoritative. */
  raw: string
}

interface Props {
  initial: string
  /** Agent file path from the API route, e.g. "openagentd" or "coding/coder". */
  agentPath?: string
  /** Fires on every keystroke with the up-to-date raw content. */
  onChange: (raw: string) => void
  /** Disabled when the caller is mid-save / validation. */
  disabled?: boolean
  /** When creating a new agent the name is still editable. */
  isNew?: boolean
  /** Controlled Form/Raw mode — owned by the parent so the sub-header
   *  toggle stays in sync with the form body. */
  mode: 'form' | 'raw'
  onModeChange: (next: 'form' | 'raw') => void
}

const THINKING_LEVELS: Array<{ value: string; label: string }> = [
  { value: '__none__', label: '(default)' },
  { value: 'none', label: 'none' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]

export function AgentForm({
  initial,
  agentPath,
  onChange,
  disabled,
  isNew,
  mode,
  onModeChange,
}: Props) {
  const [raw, setRaw] = useState(initial)

  // Seed form state from the initial raw content. Subsequent edits update
  // `raw` via `updateFromForm` / `updateFromRaw` — never from `initial`.
  const seed = useMemo(() => parseFormState(initial), [initial])
  const [fm, setFm] = useState<AgentFrontmatter>(seed.fm)
  const [body, setBody] = useState(seed.body)
  const [parseError, setParseError] = useState<string | null>(seed.error)

  // If the parent swaps `initial` (e.g. navigating between agents), adopt
  // the new seed. We track the last-seen initial in state so this is a
  // plain derived-state update rather than an effect.
  const [lastInitial, setLastInitial] = useState(initial)
  if (initial !== lastInitial) {
    setLastInitial(initial)
    setRaw(initial)
    setFm(seed.fm)
    setBody(seed.body)
    setParseError(seed.error)
  }

  // When the parent flips mode, re-parse if going back to form so we don't
  // show stale field values.
  const [lastMode, setLastMode] = useState(mode)
  if (mode !== lastMode) {
    setLastMode(mode)
    if (mode === 'form') {
      const p = parseFormState(raw)
      setFm(p.fm)
      setBody(p.body)
      setParseError(p.error)
    }
  }

  const registry = useRegistryQuery()
  const mcpServers = useMcpServersQuery()
  const agentFiles = useAgentFilesQuery()

  // Hide ``mcp_<server>_<tool>`` entries from the Tools picker — they are
  // granted en bloc via the MCP server picker below, so showing them in
  // both places would let the user pick the same capability twice.
  const toolOptions: MultiSelectOption[] =
    registry.data?.tools
      .filter((t) => !t.name.startsWith('mcp_'))
      .map((t) => ({
        value: t.name,
        label: t.name,
        description: t.description,
      })) ?? []

  const skillOptions: MultiSelectOption[] =
    registry.data?.skills.map((s) => ({
      value: s.name,
      label: s.name,
      description: s.description,
    })) ?? []

  // Show every server, including disabled / errored ones, so an agent can
  // still reference a server that's temporarily down without the picker
  // silently dropping the chip on save.
  const mcpOptions: MultiSelectOption[] =
    mcpServers.data?.servers.map((s) => {
      const tools = s.tool_names.length
      const detail = `${s.transport} · ${s.state} · ${tools} tool${tools === 1 ? '' : 's'}`
      return {
        value: s.name,
        label: s.name,
        description: detail,
      }
    }) ?? []

  const agentSummary = agentFiles.data?.agents.find((a) => a.name === agentPath)
  const modelOptions = registry.data?.models ?? []

  // Form → raw propagation. Runs whenever a form field changes.
  const updateFromForm = (next: AgentFrontmatter, nextBody: string) => {
    setFm(next)
    setBody(nextBody)
    const r = combine(next, nextBody)
    setRaw(r)
    onChange(r)
    setParseError(null)
  }

  // Raw → form propagation. Parsing may fail; we surface the error but
  // still let the user fix it in raw mode.
  const updateFromRaw = (nextRaw: string) => {
    setRaw(nextRaw)
    onChange(nextRaw)
    const p = parseFormState(nextRaw)
    setFm(p.fm)
    setBody(p.body)
    setParseError(p.error)
  }

  return (
    <div className="flex flex-col gap-4">
      {parseError && (
        <ParseErrorBanner
          message={parseError}
          onSwitchToRaw={() => onModeChange('raw')}
        />
      )}

      {mode === 'form' ? (
        <FormFields
          fm={fm}
          body={body}
          disabled={disabled}
          isNew={isNew}
          toolOptions={toolOptions}
          skillOptions={skillOptions}
          mcpOptions={mcpOptions}
          modelOptions={modelOptions}
          agentPath={agentPath}
          effectiveTools={agentSummary?.tools}
          updateFromForm={updateFromForm}
        />
      ) : (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Raw .md</CardTitle>
            <CardDescription>
              Edit the raw frontmatter and body. Useful for fields the form
              doesn&rsquo;t expose (e.g. custom hook configuration).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={raw}
              onChange={(e) => updateFromRaw(e.target.value)}
              disabled={disabled}
              rows={28}
              spellCheck={false}
              className="min-h-72 font-mono text-[13px] leading-relaxed"
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ParseErrorBanner({
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
      <Button size="xs" variant="outline" className="min-h-11 md:min-h-0" onClick={onSwitchToRaw}>
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
function FormFields({
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
  const validModelIds = useMemo(
    () => modelOptions.map((m) => m.id),
    [modelOptions],
  )
  const modelError = validateModel(fm.model ?? '', {
    required: true,
    validValues: validModelIds,
  })
  const fallbackError = validateModel(fm.fallback_model ?? '', {
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
              options={modelOptions}
              onChange={(v) => updateFromForm({ ...fm, model: v }, body)}
              disabled={disabled}
              invalid={!!modelError}
              placeholder="Type to search models…"
            />
          </Field>

          <Field
            label="Fallback model"
            error={fallbackError}
            hint="Used when the primary model errors out. Leave blank for none."
            className="md:col-span-2"
          >
            <ModelCombobox
              value={fm.fallback_model ?? ''}
              options={modelOptions}
              onChange={(v) => updateFromForm({ ...fm, fallback_model: v || null }, body)}
              disabled={disabled}
              invalid={!!fallbackError}
              placeholder="Type to search models (or leave blank)…"
            />
          </Field>

          <Field label="Temperature" error={tempError} hint="0 – 2; higher = more random.">
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

const NORMAL_BUILT_IN_MEMBERS = new Set(['executor', 'explorer'])
const CODING_BUILT_IN_MEMBERS = new Set(['coder', 'explorer'])

function isBuiltInProfile(
  name?: string,
  role?: string | null,
  agentPath?: string,
): boolean {
  if (!name || !role) return false
  const path = agentPath ?? name
  const isCoding = path.startsWith('coding/')
  const basename = path.split('/').pop() ?? name
  if (role === 'lead') return basename === 'openagentd'
  if (role !== 'member') return false
  return isCoding
    ? CODING_BUILT_IN_MEMBERS.has(basename)
    : NORMAL_BUILT_IN_MEMBERS.has(basename)
}

// ── Model combobox ──────────────────────────────────────────────────────────

export interface ModelOption {
  id: string
  provider: string
  model: string
  vision: boolean
  output_image?: boolean
  output_video?: boolean
}

/**
 * Typeahead combobox for picking a registry model id (``provider:model``).
 *
 * The user types into a regular text input; matches from the registry are
 * ranked by ``fuzzysort`` and rendered in a floating list below. Picking
 * an entry (click, ↑/↓ + Enter) commits the value. Free-text values that
 * don't match a registry entry are flagged by ``validateModel`` upstream
 * — the input itself doesn't gate keystrokes so the user can edit freely.
 *
 * Empty input commits an empty string, which the caller may interpret as
 * "unset" (used for ``fallback_model``).
 */
export function ModelCombobox({
  value,
  onChange,
  options,
  disabled,
  invalid,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: ModelOption[]
  disabled?: boolean
  invalid?: boolean
  placeholder?: string
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Adopt external value changes (e.g. switching agents) without losing
  // the user's in-progress query while focused.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setQuery(value)
  }

  // Track the input's viewport rect while the dropdown is open so the
  // portalled list stays pinned beneath it as the page scrolls or the
  // window resizes. Measured synchronously after layout so the first
  // frame after open is already positioned correctly.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (rect) setAnchorRect(rect)
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // Close when a click/focus lands outside the input *and* the dropdown.
  // The portalled list isn't a DOM descendant of the wrapper, so we
  // can't rely on a single onBlur handler.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (
        wrapperRef.current?.contains(target) ||
        listRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Filter + rank with fuzzysort. Empty query → full list (provider order).
  const filtered = useMemo<ModelOption[]>(() => {
    const q = query.trim()
    if (!q) return options
    // Indexing into ``id`` (the qualified ``provider:model``) means
    // searching ``gpt5`` and ``openai:gpt-5.4`` both work.
    const results = fuzzysort.go(q, options, {
      key: 'id',
      threshold: 0.2,
      limit: 50,
    })
    return results.map((r) => r.obj)
  }, [options, query])

  // Clamp highlight when the list shrinks. Derived-state pattern (see
  // React docs: "You might not need an effect").
  const [lastLen, setLastLen] = useState(filtered.length)
  if (lastLen !== filtered.length) {
    setLastLen(filtered.length)
    setHighlight((h) => Math.min(h, Math.max(filtered.length - 1, 0)))
  }

  const commit = (next: string) => {
    setQuery(next)
    onChange(next)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      const row = filtered[highlight]
      if (row) commit(row.id)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="model-combobox-list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
            setOpen(true)
            // Push the in-progress query upstream so validation surfaces
            // "Not in the provider model list" as the user types past a
            // known entry. Empty query commits an empty value.
            onChange(e.target.value)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? 'Type to search models…'}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 pr-11 font-mono md:min-h-9 md:pr-8"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? 'Close model list' : 'Open model list'}
          onMouseDown={(e) => {
            // Toggle without stealing focus from the input.
            e.preventDefault()
            setOpen((v) => !v)
            inputRef.current?.focus()
          }}
          disabled={disabled}
          className="absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-(--color-text-muted) transition-colors hover:text-(--color-text) disabled:opacity-50 md:right-1 md:h-8 md:w-8"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>

      {open && !disabled && anchorRect &&
        createPortal(
          <ul
            ref={listRef}
            id="model-combobox-list"
            role="listbox"
            // Portalled to document.body so the dropdown escapes any
            // ancestor with ``overflow-hidden`` (e.g. the Card primitive).
            // Positioned in viewport coords via the tracked anchor rect.
            style={{
              position: 'fixed',
              top: anchorRect.bottom + 4,
              left: anchorRect.left,
              width: anchorRect.width,
            }}
            className="z-50 max-h-64 overflow-y-auto rounded-lg border border-(--color-border-strong) bg-(--bg-page) p-1 shadow-[0_8px_24px_rgba(26,23,20,0.16)]"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-(--color-text-muted)">
                No matching models
              </li>
            ) : (
              filtered.map((o, i) => {
                const isHi = i === highlight
                const isSel = o.id === value
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o.id)}
                      onMouseEnter={() => setHighlight(i)}
                      className={cn(
                        'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs transition-colors md:min-h-0',
                        isHi && 'bg-(--bg-key)',
                        isSel && 'text-(--color-accent)',
                      )}
                    >
                      <span className="min-w-0 truncate">{o.id}</span>
                      {o.vision && (
                        <span className="shrink-0 text-[10px] text-(--color-text-muted)">
                          vision
                        </span>
                      )}
                    </button>
                  </li>
                )
              })
            )}
          </ul>,
          document.body,
        )}
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
  children: React.ReactNode
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

// ── Raw → form parser ───────────────────────────────────────────────────────

function parseFormState(raw: string): {
  fm: AgentFrontmatter
  body: string
  error: string | null
} {
  const { fm: fmText, body } = splitFrontmatter(raw)
  const fm: AgentFrontmatter = { name: '', role: 'member' }

  if (!fmText.trim()) {
    return { fm, body, error: 'Missing YAML frontmatter (needs --- … --- header).' }
  }

  try {
    const parsed = parseSimpleYaml(fmText)
    if (typeof parsed.name === 'string') fm.name = parsed.name
    if (parsed.role === 'lead' || parsed.role === 'member') fm.role = parsed.role
    if (typeof parsed.description === 'string') fm.description = parsed.description
    if (typeof parsed.model === 'string') fm.model = parsed.model
    if (typeof parsed.fallback_model === 'string') fm.fallback_model = parsed.fallback_model
    if (typeof parsed.temperature === 'number') fm.temperature = parsed.temperature
    if (typeof parsed.thinking_level === 'string') fm.thinking_level = parsed.thinking_level
    if (Array.isArray(parsed.tools)) fm.tools = parsed.tools.filter((x) => typeof x === 'string')
    if (Array.isArray(parsed.skills)) fm.skills = parsed.skills.filter((x) => typeof x === 'string')
    if (Array.isArray(parsed.mcp)) fm.mcp = parsed.mcp.filter((x) => typeof x === 'string')
    return { fm, body, error: null }
  } catch (err) {
    return { fm, body, error: String((err as Error).message ?? err) }
  }
}

/**
 * Minimal YAML parser — handles the subset our AgentForm emits:
 * scalar key/values and bullet lists of strings. Anything more exotic
 * (nested objects, block scalars, anchors, flow style) is ignored
 * silently; the raw editor remains the escape hatch.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let currentKey: string | null = null
  let currentList: string[] | null = null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    // List continuation
    const listMatch = /^\s+-\s+(.*)$/.exec(line)
    if (currentList && listMatch) {
      currentList.push(unquote(listMatch[1]))
      continue
    }

    const kvMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kvMatch) {
      // Unknown indented content — skip gracefully.
      continue
    }
    const [, key, rawValue] = kvMatch
    currentKey = key
    currentList = null

    if (rawValue === '') {
      // Expect list on following lines.
      currentList = []
      out[currentKey] = currentList
      continue
    }
    out[currentKey] = coerce(unquote(rawValue))
  }
  return out
}

function unquote(v: string): string {
  const t = v.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~' || v === '') return null
  const n = Number(v)
  if (!Number.isNaN(n) && v.trim() !== '') return n
  return v
}

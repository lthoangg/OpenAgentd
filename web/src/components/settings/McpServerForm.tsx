/**
 * McpServerForm — controlled form for an MCP server configuration.
 *
 * Mirrors the AgentForm shape:
 *   - the form is a pure controlled view of `value`; on every edit it
 *     emits a fresh `McpServerDraft` via `onChange`.
 *   - the route owns persistence, dirty/invalid bookkeeping, and the
 *     sticky save bar (rendered separately via `EditorSubHeader`).
 *
 * Draft model + validators live in `./McpServerDraft` so this module
 * stays component-only (Vite fast-refresh requirement).
 */
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { SettingsField } from './SettingsField'
import { SettingsSection } from './SettingsSection'
import type { KeyValuePair, McpServerDraft } from './McpServerDraft'

interface McpServerFormProps {
  value: McpServerDraft
  onChange: (next: McpServerDraft) => void
  /** When true, the name input is editable. */
  isNew?: boolean
  /** Disable every interactive control (mid-save). */
  disabled?: boolean
  /** Field-level errors keyed by `name | command | url | env | headers`. */
  errors?: Record<string, string> | null
}

export function McpServerForm({
  value,
  onChange,
  isNew,
  disabled,
  errors,
}: McpServerFormProps) {
  const set = (patch: Partial<McpServerDraft>) => onChange({ ...value, ...patch })
  return (
    <div className="flex flex-col gap-4">
      {/* Identity ─────────────────────────────────────────────────── */}
      <SettingsSection title="Identity" description="how agents and the runtime address this server">
        <div className="grid gap-3 md:grid-cols-2">
          <SettingsField
            label="Name"
            required
            error={errors?.name}
            hint={
              !isNew
                ? 'Persisted key in mcp.json; cannot be renamed.'
                : 'Letters, digits, _ or -; must start with a letter.'
            }
          >
            <Input
              value={value.name}
              onChange={(e) => set({ name: e.target.value })}
              disabled={disabled || !isNew}
              placeholder="filesystem"
              aria-invalid={!!errors?.name || undefined}
              className="min-h-11 font-mono md:min-h-9"
            />
          </SettingsField>

          <SettingsField
            label="Status"
            hint={value.enabled ? 'Server is started at runtime.' : 'Server is left stopped.'}
          >
            <EnabledToggle
              value={value.enabled}
              onChange={(enabled) => set({ enabled })}
              disabled={disabled}
            />
          </SettingsField>
        </div>
      </SettingsSection>

      {/* Transport + connection fields — merged into one section ── */}
      <SettingsSection
        title={value.transport === 'stdio' ? 'Transport — Stdio' : 'Transport — HTTP'}
        description={value.transport === 'stdio' ? 'subprocess speaking MCP over stdin/stdout' : 'Streamable HTTP session'}
      >
        <div className="flex flex-col gap-3">
          {/* Transport picker always at the top */}
          <TransportToggle
            value={value.transport}
            onChange={(transport) => set({ transport })}
            disabled={disabled}
          />

          {/* Divider between picker and transport-specific fields */}
          <div className="border-t border-(--color-border)" />

          {/* ── Stdio fields ── */}
          {value.transport === 'stdio' && (
            <>
              <SettingsField
                label="Command"
                required
                error={errors?.command}
                hint="Executable to launch (looked up on PATH)."
              >
                <Input
                  value={value.command}
                  onChange={(e) => set({ command: e.target.value })}
                  disabled={disabled}
                  placeholder="npx"
                  aria-invalid={!!errors?.command || undefined}
                  className="min-h-11 font-mono md:min-h-9"
                />
              </SettingsField>

              <SettingsField label="Arguments" hint="One per line, in order.">
                <Textarea
                  value={value.argsText}
                  onChange={(e) => set({ argsText: e.target.value })}
                  disabled={disabled}
                  rows={4}
                  spellCheck={false}
                  placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"
                  className="min-h-32 font-mono text-[13px] leading-relaxed"
                />
              </SettingsField>

              <PairListField
                label="Environment variables"
                keyPlaceholder="KEY"
                valuePlaceholder="value"
                error={errors?.env}
                pairs={value.envPairs}
                onChange={(envPairs) => set({ envPairs })}
                disabled={disabled}
              />
            </>
          )}

          {/* ── HTTP fields ── */}
          {value.transport === 'http' && (
            <>
              <SettingsField
                label="URL"
                required
                error={errors?.url}
                hint="Streamable HTTP endpoint (full URL incl. scheme)."
              >
                <Input
                  value={value.url}
                  onChange={(e) => set({ url: e.target.value })}
                  disabled={disabled}
                  placeholder="https://mcp.example.com/v1"
                  aria-invalid={!!errors?.url || undefined}
                  className="min-h-11 font-mono md:min-h-9"
                />
              </SettingsField>

              <PairListField
                label="Headers"
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                error={errors?.headers}
                pairs={value.headerPairs}
                onChange={(headerPairs) => set({ headerPairs })}
                disabled={disabled}
              />

              <SettingsField
                label="OAuth"
                error={errors?.oauth}
                hint={
                  value.oauthEnabled
                    ? 'Paste app credentials here. They are saved to .env and referenced from mcp.json.'
                    : 'Enable for hosted servers like Slack or Notion that require user OAuth.'
                }
              >
                <EnabledToggle
                  value={value.oauthEnabled}
                  onChange={(oauthEnabled) => set({ oauthEnabled })}
                  disabled={disabled}
                  enabledLabel="OAuth"
                  disabledLabel="None"
                />
              </SettingsField>

              {value.oauthEnabled && (
                <div className="rounded-xs border border-dashed border-(--color-border) px-3 py-2.5 text-xs text-(--color-text-muted)">
                  Leave blank only for servers that support dynamic OAuth registration, such as Notion.
                </div>
              )}

              {value.oauthEnabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <SettingsField label="Client ID" hint="Paste the OAuth app client ID.">
                    <Input
                      value={value.oauthClientIdEnv}
                      onChange={(e) => set({ oauthClientIdEnv: e.target.value })}
                      disabled={disabled}
                      placeholder="client id"
                      className="min-h-11 font-mono md:min-h-9"
                    />
                  </SettingsField>
                  <SettingsField label="Client secret" hint="Paste the OAuth app client secret.">
                    <Input
                      value={value.oauthClientSecretEnv}
                      onChange={(e) => set({ oauthClientSecretEnv: e.target.value })}
                      disabled={disabled}
                      placeholder="client secret"
                      className="min-h-11 font-mono md:min-h-9"
                    />
                  </SettingsField>
                </div>
              )}
            </>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}

// SettingsField imported from './SettingsField'; local Field removed.

// ── Enabled toggle ──────────────────────────────────────────────────────────

/**
 * Two-button segmented toggle. We don't have a shadcn Switch in the
 * codebase, and a styled native checkbox feels out of place next to the
 * Tabs/Card aesthetic — the segmented control matches it.
 */
function EnabledToggle({
  value,
  onChange,
  disabled,
  enabledLabel = 'Enabled',
  disabledLabel = 'Disabled',
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  enabledLabel?: string
  disabledLabel?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Server enabled state"
      className="inline-flex min-h-11 rounded-sm border border-(--color-border) bg-(--bg-key) p-0.5 md:min-h-9"
    >
      <ToggleOption
        active={value}
        onClick={() => onChange(true)}
        disabled={disabled}
        label={enabledLabel}
      />
      <ToggleOption
        active={!value}
        onClick={() => onChange(false)}
        disabled={disabled}
        label={disabledLabel}
      />
    </div>
  )
}

function TransportToggle({
  value,
  onChange,
  disabled,
}: {
  value: 'stdio' | 'http'
  onChange: (next: 'stdio' | 'http') => void
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="MCP transport"
      className="grid min-h-11 w-full grid-cols-2 rounded-sm border border-(--color-border) bg-(--bg-key) p-1 md:min-h-10"
    >
      <ToggleOption
        active={value === 'stdio'}
        onClick={() => onChange('stdio')}
        disabled={disabled}
        label="Stdio"
      />
      <ToggleOption
        active={value === 'http'}
        onClick={() => onChange('http')}
        disabled={disabled}
        label="HTTP"
      />
    </div>
  )
}

function ToggleOption({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex-1 rounded-sm px-3 text-xs font-medium transition-colors',
        active
          ? 'bg-(--bg-card) text-(--color-text) shadow-sm'
          : 'text-(--color-text-muted) hover:text-(--color-text)',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
    </button>
  )
}

// ── Pair list field (env vars, headers) ─────────────────────────────────────

function PairListField({
  label,
  keyPlaceholder,
  valuePlaceholder,
  error,
  pairs,
  onChange,
  disabled,
}: {
  label: string
  keyPlaceholder: string
  valuePlaceholder: string
  error?: string | null
  pairs: KeyValuePair[]
  onChange: (next: KeyValuePair[]) => void
  disabled?: boolean
}) {
  const setAt = (idx: number, patch: Partial<KeyValuePair>) =>
    onChange(pairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  const removeAt = (idx: number) => onChange(pairs.filter((_, i) => i !== idx))
  const append = () => onChange([...pairs, { key: '', value: '' }])

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-(--color-text)">{label}</span>
        <Button
          size="xs"
          variant="ghost"
          className="min-h-11 md:min-h-0"
          onClick={append}
          disabled={disabled}
          aria-label={`Add ${label.toLowerCase()}`}
        >
          <Plus size={11} aria-hidden="true" />
          Add
        </Button>
      </div>

      {pairs.length === 0 ? (
        <p className="text-[11px] text-(--color-text-muted)">None.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {pairs.map((pair, idx) => (
            <div key={idx} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
              <Input
                value={pair.key}
                onChange={(e) => setAt(idx, { key: e.target.value })}
                disabled={disabled}
                placeholder={keyPlaceholder}
                className="min-h-11 font-mono md:min-h-9"
              />
              <Input
                value={pair.value}
                onChange={(e) => setAt(idx, { value: e.target.value })}
                disabled={disabled}
                placeholder={valuePlaceholder}
                className="min-h-11 font-mono md:min-h-9"
              />
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-11 w-11 sm:justify-self-end md:h-6 md:w-6"
                onClick={() => removeAt(idx)}
                disabled={disabled}
                aria-label={`Remove ${pair.key || 'entry'}`}
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-(--color-error)">{error}</p>}
    </div>
  )
}

/**
 * McpServerForm — controlled form for a connector (an MCP server).
 *
 * It first asks how the connector is reached, a web address or a program on
 * this computer, and shows only that half's fields; what few connectors change
 * (status, timeout, headers, app credentials, protocol) sits under Options.
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
import { useEffect } from 'react'
import { useForm } from '@tanstack/react-form'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Field } from '@/components/ui/field'
import { PanelSection } from '@/components/ui/panel-section'
import { Switch } from '@/components/ui/switch'
import { TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'
import { MAX_MCP_TIMEOUT_S, type KeyValuePair, type McpServerDraft } from './McpServerDraft'

interface McpServerFormProps {
  value: McpServerDraft
  onChange: (next: McpServerDraft) => void
  /** When true, the name input is editable. */
  isNew?: boolean
  /** Disable every interactive control (mid-save). */
  disabled?: boolean
  /** Field-level errors keyed by `name | command | url | env | headers | timeout`. */
  errors?: Record<string, string> | null
}

export function McpServerForm({
  value,
  onChange,
  isNew,
  disabled,
  errors,
}: McpServerFormProps) {
  const form = useForm({
    defaultValues: value,
    onSubmit: () => {},
  })

  useEffect(() => {
    form.reset(value)
  }, [form, value])

  const set = (patch: Partial<McpServerDraft>) => {
    const next = { ...value, ...patch }
    form.reset(next)
    onChange(next)
  }
  const viaAddress = value.transport !== 'stdio'
  const nameField = (
    <Field
      label="Name"
      required
      htmlFor="mcp-name"
      error={errors?.name}
      errorId="mcp-name-error"
      hint={
        !isNew
          ? 'Saved in mcp.json under this name. It cannot be renamed.'
          : 'What agents call it. Letters, digits, _ or -, starting with a letter.'
      }
    >
      <Input
        id="mcp-name"
        value={value.name}
        onChange={(e) => set({ name: e.target.value })}
        disabled={disabled || !isNew}
        placeholder={viaAddress ? 'Filled in from the address' : 'filesystem'}
        aria-invalid={!!errors?.name || undefined}
        aria-describedby={errors?.name ? 'mcp-name-error' : undefined}
        className="min-h-9 font-mono"
      />
    </Field>
  )

  return (
    <div className="flex flex-col gap-8">
      {/* The first question, then only that half's fields ───────────── */}
      <PanelSection title="How does it connect?">
        <div className="flex flex-col gap-5">
          <SegmentedControl
            label="How does it connect?"
            value={viaAddress ? 'address' : 'program'}
            onChange={(how) => {
              if ((how === 'address') !== viaAddress) set({ transport: how === 'address' ? 'http' : 'stdio' })
            }}
            options={[
              { value: 'address', label: 'A web address' },
              // The last words leave a narrow screen, where both answers would not fit.
              { value: 'program', label: <>A program<span className="max-sm:hidden"> on this computer</span></> },
            ]}
            disabled={disabled}
            fill
          />

          {viaAddress ? (
            <>
              <Field
                label="Address"
                required
                htmlFor="mcp-url"
                error={errors?.url}
                errorId="mcp-url-error"
                hint="From the tool's own setup page (Notion, Slack, GitHub and others publish one)."
              >
                <Input
                  id="mcp-url"
                  value={value.url}
                  onChange={(e) => set({ url: e.target.value })}
                  disabled={disabled}
                  placeholder="https://mcp.example.com/v1"
                  aria-invalid={!!errors?.url || undefined}
                  aria-describedby={errors?.url ? 'mcp-url-error' : undefined}
                  className="min-h-9 font-mono"
                />
              </Field>

              {nameField}

              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p id="mcp-oauth-label" className={TEXT.label}>Needs sign-in</p>
                  <p className={cn('mt-1', TEXT.hint)}>
                    {value.oauthEnabled
                      ? 'Most hosted tools do. You sign in once it is saved.'
                      : 'For tools that need no sign-in, or that take a key under Headers.'}
                  </p>
                  {errors?.oauth && <p className="mt-1 text-meta text-(--color-error)">{errors.oauth}</p>}
                </div>
                <Switch
                  aria-labelledby="mcp-oauth-label"
                  checked={value.oauthEnabled}
                  onCheckedChange={(oauthEnabled) => set({ oauthEnabled })}
                  disabled={disabled}
                />
              </div>
            </>
          ) : (
            <>
              <Field
                label="Command"
                required
                htmlFor="mcp-command"
                error={errors?.command}
                errorId="mcp-command-error"
                hint="A program on your PATH, or an absolute path."
              >
                <Input
                  id="mcp-command"
                  value={value.command}
                  onChange={(e) => set({ command: e.target.value })}
                  disabled={disabled}
                  placeholder="npx"
                  aria-invalid={!!errors?.command || undefined}
                  aria-describedby={errors?.command ? 'mcp-command-error' : undefined}
                  className="min-h-9 font-mono"
                />
              </Field>

              <Field label="Arguments" htmlFor="mcp-args" hint="One per line, in order.">
                <Textarea
                  id="mcp-args"
                  value={value.argsText}
                  onChange={(e) => set({ argsText: e.target.value })}
                  disabled={disabled}
                  rows={4}
                  spellCheck={false}
                  placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"
                  className="min-h-32 font-mono text-code leading-relaxed"
                />
              </Field>

              <PairListField
                label="Environment variables"
                keyPlaceholder="KEY"
                valuePlaceholder="value"
                error={errors?.env}
                errorId="mcp-env-error"
                pairs={value.envPairs}
                onChange={(envPairs) => set({ envPairs })}
                disabled={disabled}
              />

              {nameField}
            </>
          )}
        </div>
      </PanelSection>

      {/* What most connectors never change ─────────────────────────── */}
      <PanelSection title="Options">
        <div className="flex flex-col gap-5">
          <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
            <Field
              label="Status"
              hint={value.enabled ? 'Starts with OpenAgentd.' : 'Stays stopped; agents cannot use its tools.'}
            >
              <EnabledToggle
                value={value.enabled}
                onChange={(enabled) => set({ enabled })}
                disabled={disabled}
              />
            </Field>

            <Field
              label="Tool timeout (seconds)"
              htmlFor="mcp-timeout"
              error={errors?.timeout}
              errorId="mcp-timeout-error"
              hint={`How long a tool call may run before it is cancelled, 1 to ${MAX_MCP_TIMEOUT_S}. Leave empty for 210.`}
            >
              <Input
                id="mcp-timeout"
                value={value.timeoutText}
                onChange={(e) => set({ timeoutText: e.target.value })}
                disabled={disabled}
                inputMode="numeric"
                placeholder="210"
                aria-invalid={!!errors?.timeout || undefined}
                aria-describedby={errors?.timeout ? 'mcp-timeout-error' : undefined}
                className="min-h-9 font-mono"
              />
            </Field>
          </div>

          {viaAddress && (
            <>
              <PairListField
                label="Headers"
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                error={errors?.headers}
                errorId="mcp-headers-error"
                pairs={value.headerPairs}
                onChange={(headerPairs) => set({ headerPairs })}
                disabled={disabled}
              />

              {value.oauthEnabled && (
                <div className="grid gap-x-4 gap-y-5 md:grid-cols-2">
                  <Field
                    label="Client ID"
                    htmlFor="mcp-client-id"
                    hint="Only if the tool gave you app credentials. Leave empty to let it register this app."
                  >
                    <Input
                      id="mcp-client-id"
                      value={value.oauthClientIdEnv}
                      onChange={(e) => set({ oauthClientIdEnv: e.target.value })}
                      disabled={disabled}
                      className="min-h-9 font-mono"
                    />
                  </Field>
                  <Field
                    label="Client secret"
                    htmlFor="mcp-client-secret"
                    hint="Stored apart from mcp.json, in credentials.yaml."
                  >
                    <Input
                      id="mcp-client-secret"
                      value={value.oauthClientSecretEnv}
                      onChange={(e) => set({ oauthClientSecretEnv: e.target.value })}
                      disabled={disabled}
                      className="min-h-9 font-mono"
                    />
                  </Field>
                </div>
              )}

              <Field
                label="Protocol"
                hint={
                  value.transport === 'sse'
                    ? 'Uses only the older SSE protocol.'
                    : 'Tries the current protocol first, then the older SSE one.'
                }
              >
                <SegmentedControl
                  label="Protocol"
                  value={value.transport === 'sse' ? 'sse' : 'http'}
                  onChange={(transport) => set({ transport })}
                  options={[
                    { value: 'http', label: 'Automatic' },
                    { value: 'sse', label: 'SSE only' },
                  ]}
                  disabled={disabled}
                />
              </Field>
            </>
          )}
        </div>
      </PanelSection>
    </div>
  )
}

// ── Enabled toggle ──────────────────────────────────────────────────────────

/** On / Off as two segments: it is saved with the form, so it is not a switch. */
function EnabledToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <SegmentedControl
      label="Connector status"
      value={value ? 'enabled' : 'disabled'}
      onChange={(v) => onChange(v === 'enabled')}
      options={[
        { value: 'enabled', label: 'On' },
        { value: 'disabled', label: 'Off' },
      ]}
      disabled={disabled}
    />
  )
}

// ── Pair list field (env vars, headers) ─────────────────────────────────────

function PairListField({
  label,
  keyPlaceholder,
  valuePlaceholder,
  error,
  errorId,
  pairs,
  onChange,
  disabled,
}: {
  label: string
  keyPlaceholder: string
  valuePlaceholder: string
  error?: string | null
  errorId: string
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
          className="min-h-9 md:min-h-0"
          onClick={append}
          disabled={disabled}
          aria-label={`Add ${label.toLowerCase()}`}
        >
          <Plus size={12} aria-hidden="true" />
          Add
        </Button>
      </div>

      {pairs.length === 0 ? (
        <p className="text-meta text-(--color-text-muted)">None.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {pairs.map((pair, idx) => (
            <div key={idx} className="grid gap-1.5 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
              <Input
                value={pair.key}
                onChange={(e) => setAt(idx, { key: e.target.value })}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={disabled}
                placeholder={keyPlaceholder}
                className="min-h-9 font-mono"
              />
              <Input
                value={pair.value}
                onChange={(e) => setAt(idx, { value: e.target.value })}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={disabled}
                placeholder={valuePlaceholder}
                className="min-h-9 font-mono"
              />
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-9 w-9 justify-self-end md:h-6 md:w-6"
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

      {error && <p id={errorId} className="text-meta text-(--color-error)">{error}</p>}
    </div>
  )
}

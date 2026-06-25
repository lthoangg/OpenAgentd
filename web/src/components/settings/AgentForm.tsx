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
import { useMemo, useState } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

import { useAgentFilesQuery, useMcpServersQuery, useRegistryQuery } from '@/queries'
import { type MultiSelectOption } from './MultiSelect'
import { combine, type AgentFrontmatter } from './frontmatter'
import { FormFields, ParseErrorBanner } from './AgentForm/FormFields'
import { parseFormState } from './AgentForm/utils'

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

  // Hide ``<server>_<tool>`` entries from the Tools picker — they are
  // granted en bloc via the MCP server picker below, so showing them in
  // both places would let the user pick the same capability twice.
  const toolOptions: MultiSelectOption[] =
    registry.data?.tools
      .filter((t) => !mcpServers.data?.servers.some((s) => t.name.startsWith(`${s.name}_`)))
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

export { ModelCombobox, type ModelOption } from './AgentForm/ModelCombobox'

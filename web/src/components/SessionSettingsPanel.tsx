/**
 * Session settings — modal for current-session model controls and lead-agent context.
 *
 * Shape: centered modal with current-session controls first, followed by
 * read-only lead-agent skills, capabilities, and tools.
 *
 * Visual language:
 *   - No avatars/robot icons. Each agent identified by status dot + name.
 *   - Role shown as a pill next to the name.
 *   - Only enabled multimodal capabilities render (no dimmed noise).
 *   - Tools collapsible; search input appears above the list when >8 tools.
 */

import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import fuzzysort from 'fuzzysort'
import {
  X,
  Wrench,
  ChevronDown,
  Search,
  ImageIcon,
  FileText,
  Mic,
  Video,
  ArrowRight,
  Plug,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries'
import {
  useConnectMcpOAuthMutation,
  useMcpServersQuery,
  useUpdateMcpServerMutation,
} from '@/queries/useMcpQuery'
import type {
  AgentInfo,
  AgentCapabilities as AgentCapabilitiesType,
  TeamAgentInfo,
} from '@/api/types'
import type { ServerStatus } from '@/api/client'

const THINKING_LEVELS = [
  { value: '', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

// ── Capability chips (enabled only) ──────────────────────────────────────────

interface CapabilityChip {
  key: string
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

function CapabilityChips({ chips }: { chips: CapabilityChip[] }) {
  if (chips.length === 0) {
    return <span className="text-xs italic text-(--color-text-muted)">—</span>
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map(({ key, label, icon: Icon }) => (
        <span
          key={key}
          className="flex items-center gap-1 rounded-md bg-(--bg-key) px-2 py-0.5 text-xs text-(--color-text-2) ring-1 ring-(--color-border-strong)"
          title={label}
        >
          <Icon size={11} className="text-(--color-text-muted)" />
          {label}
        </span>
      ))}
    </div>
  )
}

function Capabilities({
  caps,
  tools,
}: {
  caps: AgentCapabilitiesType
  tools: AgentInfo['tools']
}) {
  // Tools can grant output capabilities beyond the model's native ones.
  // e.g. a text-only model + `generate_image` tool → still produces images;
  // `generate_video` (Veo) likewise adds a video output channel even when
  // the underlying chat model has no native video output.
  const canGenerateImage = caps.output.image || tools.some((t) => t.name === 'generate_image')
  const canGenerateVideo = tools.some((t) => t.name === 'generate_video')

  const inputChips: CapabilityChip[] = [
    caps.input.vision && { key: 'vision', label: 'Vision', icon: ImageIcon },
    caps.input.document_text && { key: 'docs', label: 'Documents', icon: FileText },
    caps.input.audio && { key: 'audio-in', label: 'Audio', icon: Mic },
    caps.input.video && { key: 'video', label: 'Video', icon: Video },
  ].filter(Boolean) as CapabilityChip[]

  const outputChips: CapabilityChip[] = [
    caps.output.text && { key: 'text-out', label: 'Text', icon: FileText },
    canGenerateImage && { key: 'image-out', label: 'Image', icon: ImageIcon },
    canGenerateVideo && { key: 'video-out', label: 'Video', icon: Video },
    caps.output.audio && { key: 'audio-out', label: 'Audio', icon: Mic },
  ].filter(Boolean) as CapabilityChip[]

  // Nothing to say — skip the whole section.
  if (inputChips.length === 0 && outputChips.length === 0) return null

  return (
    <section className="border-t border-(--color-border) px-5 py-4">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
        Capabilities
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <CapabilityChips chips={inputChips} />
        {inputChips.length > 0 && outputChips.length > 0 && (
          <ArrowRight size={12} className="text-(--color-text-subtle)" aria-hidden />
        )}
        <CapabilityChips chips={outputChips} />
      </div>
    </section>
  )
}

// ── Tool row ──────────────────────────────────────────────────────────────────

function ToolRow({ name, description }: { name: string; description: string }) {
  const [open, setOpen] = useState(false)
  const hasDesc = description.trim().length > 0
  return (
    <div className="overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-page) transition-colors hover:border-(--color-border-strong)">
      <button
        onClick={() => hasDesc && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${hasDesc ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Wrench size={12} className="shrink-0 text-(--color-text-muted)" />
        <code className="flex-1 truncate font-mono text-xs font-medium text-(--color-text)">{name}</code>
        {hasDesc && (
          <ChevronDown
            size={12}
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDesc && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="overflow-hidden"
          >
            <p className="border-t border-(--color-border) px-3 py-2 text-xs leading-relaxed text-(--color-text-muted)">
              {description}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Tools section ─────────────────────────────────────────────────────────────

const TOOL_SEARCH_THRESHOLD = 8

interface ToolGroup {
  /** Group identifier — null for built-ins, server name otherwise. */
  server: string | null
  tools: AgentInfo['tools']
}

/** Group tools by origin. Membership is derived from the `mcp_<server>_<tool>`
 *  naming convention enforced by `MCPTool.__init__` on the backend — the same
 *  convention the permission system already relies on, so it's the public
 *  contract. Servers listed in `mcp_servers` always appear, even with zero
 *  tools (configured but not ready); silently hiding them is worse than
 *  surfacing the state. */
function groupTools(
  tools: AgentInfo['tools'],
  mcpServers: string[],
): ToolGroup[] {
  // Sort servers longest-prefix-first so a hypothetical `mcp_foo_bar_*` server
  // is matched before `mcp_foo_*` would steal its tools.
  const servers = [...mcpServers].sort((a, b) => b.length - a.length)
  const buckets = new Map<string, AgentInfo['tools']>(
    mcpServers.map((s) => [s, []]),
  )
  const builtins: AgentInfo['tools'] = []

  for (const tool of tools) {
    const owner = servers.find((s) => tool.name.startsWith(`mcp_${s}_`))
    if (owner) buckets.get(owner)!.push(tool)
    else builtins.push(tool)
  }

  const groups: ToolGroup[] = []
  if (builtins.length > 0) groups.push({ server: null, tools: builtins })
  for (const name of [...mcpServers].sort()) {
    groups.push({ server: name, tools: buckets.get(name) ?? [] })
  }
  return groups
}

function ToolGroupHeader({
  server,
  count,
}: {
  server: string | null
  count: number
}) {
  if (server === null) {
    return (
      <div className="flex items-center gap-2 px-5 pt-3 pb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          Built-in
        </h4>
        <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
          {count}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-5 pt-3 pb-1.5">
      <Plug size={11} className="text-(--color-text-muted)" aria-hidden />
      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
        MCP · {server}
      </h4>
      <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
        {count}
      </span>
    </div>
  )
}

function Tools({
  tools,
  mcpServers,
  serverStatuses,
  onToggleServer,
  onConnectOAuth,
  busyServer,
}: {
  tools: AgentInfo['tools']
  mcpServers: string[]
  serverStatuses: Map<string, ServerStatus>
  onToggleServer: (server: ServerStatus) => void
  onConnectOAuth: (server: ServerStatus) => void
  busyServer: string | null
}) {
  const [query, setQuery] = useState('')
  const showSearch = tools.length > TOOL_SEARCH_THRESHOLD

  const filteredTools = useMemo(() => {
    if (!query.trim()) return tools
    const q = query.toLowerCase()
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [tools, query])

  // Always pass the full mcpServers list so the user can see configured-but-empty
  // servers; once they type a query, we hide empty groups so the filtered view
  // doesn't get padded out by sections that match nothing.
  const groups = useMemo(() => {
    const all = groupTools(filteredTools, mcpServers)
    if (!query.trim()) return all
    return all.filter((g) => g.tools.length > 0)
  }, [filteredTools, mcpServers, query])

  if (tools.length === 0 && mcpServers.length === 0) return null

  return (
    <section className="border-t border-(--color-border)">
      <div className="flex shrink-0 items-center gap-2 px-5 pt-4 pb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          Tools
        </h3>
        <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
          {tools.length}
        </span>
      </div>

      {showSearch && (
        <div className="shrink-0 px-5 pb-2">
          <div className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5 focus-within:border-(--color-border-strong)">
            <Search size={12} className="shrink-0 text-(--color-text-muted)" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter tools…"
              className="min-w-0 flex-1 bg-transparent text-xs text-(--color-text) placeholder:text-(--color-text-subtle) focus:outline-none"
              aria-label="Filter tools"
            />
          </div>
        </div>
      )}

      <div className="pb-5">
        {filteredTools.length === 0 && query.trim() ? (
          <p className="px-5 pt-2 text-xs italic text-(--color-text-muted)">
            No tools match “{query}”.
          </p>
        ) : (
          groups.map((group) => {
            const status = group.server ? serverStatuses.get(group.server) : undefined
            return (
            <div key={group.server ?? '__builtin__'}>
              <ToolGroupHeader server={group.server} count={group.tools.length} />
              {status && (
                <div className="mb-2 flex flex-wrap items-center gap-2 px-5">
                  <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] font-medium text-(--color-text-muted)">
                    {status.enabled ? (status.state === 'auth_required' ? 'OAuth required' : status.state) : 'disabled'}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!status.config || busyServer === status.name}
                    onClick={() => onToggleServer(status)}
                  >
                    {status.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {status.transport === 'http' && status.config?.transport === 'http' && status.config.oauth && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!status.enabled || busyServer === status.name}
                      onClick={() => onConnectOAuth(status)}
                    >
                      Connect OAuth
                    </Button>
                  )}
                  {status.error && status.state !== 'auth_required' && (
                    <span className="text-[11px] text-(--color-error)">{status.error}</span>
                  )}
                </div>
              )}
              <div className="space-y-1.5 px-5">
                {group.tools.length === 0 ? (
                  <p className="text-xs italic text-(--color-text-muted)">
                    Server not ready — no tools available.
                  </p>
                ) : (
                  group.tools.map((t) => (
                    <ToolRow key={t.name} name={t.name} description={t.description} />
                  ))
                )}
              </div>
            </div>
            )
          })
        )}
      </div>
    </section>
  )
}

function SessionModelSettings({
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
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false)
  const [activeModelIndex, setActiveModelIndex] = useState(0)
  const [activeThinkingIndex, setActiveThinkingIndex] = useState(0)

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
    setThinkingPickerOpen(false)
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
            variant="outline"
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
                className="w-full rounded-md border border-(--color-border) bg-(--bg-card) px-3 py-2 font-mono text-xs text-(--color-text) outline-none transition-colors hover:border-(--color-border-strong) focus:border-(--color-accent)"
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
              <div className="absolute left-0 top-full z-50 mt-1 w-[min(34rem,calc(90vw-3rem))] rounded-md border border-(--color-border-strong) bg-(--bg-page) p-1 shadow-[0_8px_24px_rgba(26,23,20,0.16)]">
                <div className="max-h-64 overflow-auto">
                {pickerOptions.map((model, index) => (
                  <button
                    type="button"
                    key={`${index}:${model.id}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveModelIndex(index)}
                    onClick={() => selectModel(model.id)}
                    className={`block w-full rounded-sm px-2 py-1.5 text-left font-mono text-xs text-(--color-text) transition-colors ${index === activeModelIndex ? 'bg-(--bg-key)' : 'hover:bg-(--bg-key)'}`}
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
          <div className="relative w-44 max-w-full">
          <button
            type="button"
            onClick={() => setThinkingPickerOpen((open) => !open)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setThinkingPickerOpen(true)
                setActiveThinkingIndex((index) => Math.min(index + 1, THINKING_LEVELS.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setThinkingPickerOpen(true)
                setActiveThinkingIndex((index) => Math.max(index - 1, 0))
              } else if (e.key === 'Enter' && thinkingPickerOpen) {
                e.preventDefault()
                selectThinkingLevel(THINKING_LEVELS[activeThinkingIndex]?.value ?? '')
              } else if (e.key === 'Escape') {
                setThinkingPickerOpen(false)
              }
            }}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-(--color-border) bg-(--bg-card) px-3 py-2 text-left text-xs text-(--color-text) outline-none transition-colors hover:border-(--color-border-strong) focus:border-(--color-accent)"
            aria-label="Thinking level"
            aria-haspopup="listbox"
            aria-expanded={thinkingPickerOpen}
          >
            <span>{selectedThinkingLabel}</span>
            <ChevronDown size={13} aria-hidden="true" className={`shrink-0 text-(--color-text-muted) transition-transform ${thinkingPickerOpen ? 'rotate-180' : ''}`} />
          </button>
          {thinkingPickerOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-(--color-border-strong) bg-(--bg-page) p-1 shadow-[0_8px_24px_rgba(26,23,20,0.16)]" role="listbox">
              {THINKING_LEVELS.map((level, index) => (
                <button
                  type="button"
                  key={level.value}
                  role="option"
                  aria-selected={level.value === draftThinkingLevel}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    selectThinkingLevel(level.value)
                  }}
                  onMouseEnter={() => setActiveThinkingIndex(index)}
                  onClick={(e) => e.stopPropagation()}
                  className={`block w-full rounded-sm px-2 py-1.5 text-left text-xs text-(--color-text) transition-colors ${index === activeThinkingIndex ? 'bg-(--bg-key)' : 'hover:bg-(--bg-key)'}`}
                >
                  {level.label}
                </button>
              ))}
            </div>
          )}
          </div>
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

// ── Main ──────────────────────────────────────────────────────────────────────

interface SessionSettingsPanelProps {
  /** Controls drawer visibility. Parent keeps the component mounted so
   *  framer-motion can play both the enter and exit animations. */
  open: boolean
  /** For team mode: ordered agent names (lead first). Empty = single-agent. */
  agentNames?: string[]
  workspace?: string | null
  sessionModel?: string | null
  sessionThinkingLevel?: string | null
  sessionFastMode?: boolean
  onSessionModelSettingsChange?: (model: string | null, thinkingLevel: string | null, fastMode: boolean) => void
  onClose: () => void
}

export function SessionSettingsPanel({
  open,
  agentNames = [],
  workspace = null,
  sessionModel = null,
  sessionThinkingLevel = null,
  sessionFastMode = false,
  onSessionModelSettingsChange,
  onClose,
}: SessionSettingsPanelProps) {
  const { data, isLoading, refetch } = useTeamAgentsQuery(workspace)
  const mcpServersQuery = useMcpServersQuery()
  const updateMcpServer = useUpdateMcpServerMutation()
  const connectMcpOAuth = useConnectMcpOAuthMutation()

  // Refresh on open
  useEffect(() => {
    if (open) {
      refetch()
      mcpServersQuery.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close on Escape (only while open)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  const allAgents: TeamAgentInfo[] = data?.agents ?? []
  const byName = new Map(allAgents.map((a) => [a.name, a]))

  // Resolve which agents to show. Prefer the caller's ordering; fall back to
  // the API list so the panel is never blank.
  const display: TeamAgentInfo[] = (() => {
    if (agentNames.length === 0) return allAgents
    const ordered = agentNames.map((n) => byName.get(n)).filter(Boolean) as TeamAgentInfo[]
    return ordered.length > 0 ? ordered : allAgents
  })()

  // Lead comes from the API `is_lead` flag if present, else first in list.
  const leadFromApi = allAgents.find((a) => a.is_lead)
  const leadName = display.length > 1 ? (leadFromApi?.name ?? display[0]?.name ?? null) : null
  const leadAgent = (leadName ? byName.get(leadName) : null) ?? display[0]
  const mcpServerStatuses = useMemo(
    () => new Map((mcpServersQuery.data?.servers ?? []).map((server) => [server.name, server])),
    [mcpServersQuery.data?.servers],
  )
  const busyServer = updateMcpServer.isPending
    ? updateMcpServer.variables.name
    : connectMcpOAuth.isPending
      ? connectMcpOAuth.variables
      : null
  const toggleMcpServer = (server: ServerStatus) => {
    if (!server.config) return
    updateMcpServer.mutate(
      {
        name: server.name,
        server: { ...server.config, enabled: !server.enabled },
      },
      { onSettled: () => refetch() },
    )
  }
  const connectMcpServerOAuth = (server: ServerStatus) => {
    connectMcpOAuth.mutate(server.name, { onSettled: () => refetch() })
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40"
          />

          <motion.aside
            key="dialog"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="fixed bottom-0 left-0 right-0 top-[env(safe-area-inset-top,0px)] z-50 flex flex-col overflow-hidden border border-(--color-border) bg-(--bg-card) shadow-2xl sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:h-[min(90vh,860px)] sm:w-[min(90vw,960px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md"
            role="dialog"
            aria-modal="true"
            aria-label="Session settings"
          >
        {/* Header */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-(--color-border) px-5 py-4">
          {isLoading || !leadAgent ? (
            <div className="h-6 w-48 animate-pulse rounded bg-(--bg-key)" />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-(--color-text)">
                  Session settings
                </h2>
              </div>
              <p className="mt-1 truncate text-xs text-(--color-text-muted)">
                Edit the current session, then review available capabilities below.
              </p>
            </div>
          )}
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2)"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading || !leadAgent ? (
            <div className="flex-1 space-y-3 p-5">
              <div className="h-16 animate-pulse rounded-xl bg-(--bg-key)" />
              <div className="h-24 animate-pulse rounded-xl bg-(--bg-key)" />
              <div className="h-40 animate-pulse rounded-xl bg-(--bg-key)" />
            </div>
          ) : (
            <>
              {onSessionModelSettingsChange && (
                <SessionModelSettings
                  key={`${leadAgent.model ?? ''}:${sessionModel ?? ''}:${sessionThinkingLevel ?? ''}:${sessionFastMode}`}
                  defaultModel={leadAgent.model}
                  sessionModel={sessionModel}
                  sessionThinkingLevel={sessionThinkingLevel}
                  sessionFastMode={sessionFastMode}
                  onChange={onSessionModelSettingsChange}
                />
              )}
              <section className="shrink-0 px-5 py-4">
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
                  Lead agent
                </h3>
                <p className="text-sm leading-relaxed text-(--color-text-2)">
                  {leadAgent.description?.trim() || (
                    <span className="italic text-(--color-text-muted)">No description.</span>
                  )}
                </p>
              </section>

              {leadAgent.capabilities && (
                <Capabilities caps={leadAgent.capabilities} tools={leadAgent.tools} />
              )}

              <Tools
                tools={leadAgent.tools}
                mcpServers={leadAgent.mcp_servers ?? []}
                serverStatuses={mcpServerStatuses}
                onToggleServer={toggleMcpServer}
                onConnectOAuth={connectMcpServerOAuth}
                busyServer={busyServer}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-(--color-border) px-5 py-2.5">
          <p className="text-[11px] text-(--color-text-muted)">
            Esc or click outside to close · Ctrl+A to toggle
          </p>
        </div>
      </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

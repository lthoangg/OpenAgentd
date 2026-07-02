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

import { useEffect, useMemo } from 'react'
import {
  X,
  ImageIcon,
  FileText,
  Mic,
  Video,
  ArrowRight,
} from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { SessionModelSettings } from './SessionModelSettings'
import { Tools } from './SessionSettingsPanelTools'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
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
          className="flex items-center gap-1 rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[10.5px] text-(--color-text-muted)"
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
    <section className="border-t border-(--color-border) px-3 py-3 sm:px-5 sm:py-4">
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
  const { os } = usePlatform()
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
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Session settings"
      maxWidth="1000px"
    >
        {/* Header */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-7 md:w-7"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </header>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
          {isLoading || !leadAgent ? (
            <div className="flex-1 space-y-3 p-3 sm:p-5">
              <div className="h-16 animate-pulse rounded-sm bg-(--bg-key)" />
              <div className="h-24 animate-pulse rounded-sm bg-(--bg-key)" />
              <div className="h-40 animate-pulse rounded-sm bg-(--bg-key)" />
            </div>
          ) : (
            <>
              {onSessionModelSettingsChange && (
                <SessionModelSettings
                  defaultModel={leadAgent.model}
                  sessionModel={sessionModel}
                  sessionThinkingLevel={sessionThinkingLevel}
                  sessionFastMode={sessionFastMode}
                  onChange={onSessionModelSettingsChange}
                />
              )}
              <section className="shrink-0 px-3 py-3 sm:px-5 sm:py-4">
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
        <div className="shrink-0 border-t border-(--color-border) bg-(--bg-card) px-3 py-2.5 sm:px-5">
          <p className="text-[11px] text-(--color-text-muted)">
             Esc or click outside to close · {formatShortcut('A', os, { shift: true })} to toggle
          </p>
        </div>
    </AppOverlay>
  )
}

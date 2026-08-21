/**
 * Session settings — the Shift+A overlay for the current chat session.
 *
 * Ordered by how often it's used: the session model, then the MCP server
 * switches, then the tool inventory collapsed at the bottom. The lead agent's
 * description and the capabilities matrix used to sit between them; both were
 * read-only prose that pushed the controls below the fold, so they're gone.
 * Agent details live in Settings, which is where you go to change them.
 *
 * Composition is deliberately thin: each section owns its own data and state,
 * this file only supplies the lead agent's identity and the session props.
 */

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { AppOverlay } from '@/components/ui/app-overlay'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { SessionModelSettings } from './SessionModelSettings'
import { SessionMcpServers } from './SessionMcpServers'
import { SessionTools } from './SessionTools'
import { useTeamAgentsQuery } from '@/queries/useAgentsQuery'
import type { TeamAgentInfo } from '@/api/types'

interface SessionSettingsPanelProps {
  /** Controls drawer visibility. Parent keeps the component mounted so
   *  framer-motion can play both the enter and exit animations. */
  open: boolean
  workspace?: string | null
  sessionModel?: string | null
  sessionThinkingLevel?: string | null
  onSessionModelSettingsChange?: (model: string | null, thinkingLevel: string | null) => void
  onClose: () => void
}

export function SessionSettingsPanel({
  open,
  workspace = null,
  sessionModel = null,
  sessionThinkingLevel = null,
  onSessionModelSettingsChange,
  onClose,
}: SessionSettingsPanelProps) {
  const { os } = usePlatform()
  const { data, isLoading, refetch } = useTeamAgentsQuery(workspace)
  // Keyboard users land on the model field, not the close button.
  const modelInputRef = useRef<HTMLInputElement | null>(null)

  // Config can change on disk between openings.
  useEffect(() => {
    if (open) refetch()
  }, [open, refetch])

  const allAgents: TeamAgentInfo[] = data?.agents ?? []
  // Lead comes from the API `is_lead` flag if present, else first in list. Only
  // the lead is shown: its config governs the session's default behaviour.
  const leadAgent = allAgents.find((a) => a.is_lead) ?? allAgents[0]

  // `initialFocus` on the overlay covers the warm-cache path, but on a cold
  // cache the body is still a skeleton when the trap fires and there is no
  // model field to focus yet. Claim focus once the real content mounts.
  const hasContent = !isLoading && !!leadAgent
  useEffect(() => {
    if (!open || !hasContent) return
    const id = requestAnimationFrame(() => modelInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, hasContent])

  return (
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Session settings"
      maxWidth="560px"
      initialFocus={modelInputRef}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-3 sm:px-5 sm:py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-(--color-text)">
            Session settings
          </h2>
          <p className="mt-1 truncate text-xs text-(--color-text-muted)">
            Applies from your next message.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={onClose}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-7 md:w-7"
                aria-label="Close (Esc)"
              >
                <X size={14} />
              </button>
            }
          />
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        {isLoading || !leadAgent ? (
          <div role="status" aria-label="Loading session settings" className="space-y-3 p-3 sm:p-5">
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            {onSessionModelSettingsChange && (
              <SessionModelSettings
                defaultModel={leadAgent.model}
                sessionModel={sessionModel}
                sessionThinkingLevel={sessionThinkingLevel}
                onChange={onSessionModelSettingsChange}
                modelInputRef={modelInputRef}
              />
            )}
            <SessionMcpServers
              agentServers={leadAgent.mcp_servers ?? []}
              // Enabling a server changes the agent's live tool set, which the
              // agent payload carries.
              onServersChanged={refetch}
            />
            <SessionTools
              tools={leadAgent.tools}
              mcpServers={leadAgent.mcp_servers ?? []}
            />
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-(--color-border) bg-(--bg-card) px-3 py-2.5 sm:px-5">
        <p className="text-[11px] text-(--color-text-muted)">
          Esc or click outside to close · {formatShortcut('A', os, { shift: true })} to toggle
        </p>
      </div>
    </AppOverlay>
  )
}

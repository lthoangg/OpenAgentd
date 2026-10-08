/**
 * Session settings — the Shift+A overlay for the current chat session.
 *
 * Ordered by how often it's used: the session model, then the MCP server
 * switches, then the tool inventory collapsed at the bottom. The agent's
 * description and the capabilities matrix used to sit between them; both were
 * read-only prose that pushed the controls below the fold, so they're gone.
 * Agent details live in Settings, which is where you go to change them.
 *
 * Composition is deliberately thin: each section owns its own data and state,
 * this file only supplies the agent's identity and the session props.
 */

import { useEffect, useRef } from 'react'

import { AppOverlay, OverlayHeader } from '@/components/ui/app-overlay'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { SessionModelSettings } from './SessionModelSettings'
import { SessionMcpServers } from './SessionMcpServers'
import { SessionTools } from './SessionTools'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import type { AgentInfo } from '@/api/types'

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
  const { data, isLoading, refetch } = useAgentsQuery(workspace)
  // Keyboard users land on the model field, not the close button.
  const modelInputRef = useRef<HTMLInputElement | null>(null)

  // Config can change on disk between openings.
  useEffect(() => {
    if (open) refetch()
  }, [open, refetch])

  const allAgents: AgentInfo[] = data?.agents ?? []
  // The session uses the first (and currently only) configured agent.
  const agent = allAgents[0]

  // `initialFocus` on the overlay covers the warm-cache path, but on a cold
  // cache the body is still a skeleton when the trap fires and there is no
  // model field to focus yet. Claim focus once the real content mounts.
  const hasContent = !isLoading && !!agent
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
      toggleShortcut="sessionSettings"
    >
      <OverlayHeader
        title="Session settings"
        subtitle="Applies from your next message."
        onClose={onClose}
        closeLabel="Close (Esc)"
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y">
        {isLoading || !agent ? (
          <div role="status" aria-label="Loading session settings" className="space-y-3 p-3 sm:p-5">
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            {onSessionModelSettingsChange && (
              <SessionModelSettings
                defaultModel={agent.model}
                sessionModel={sessionModel}
                sessionThinkingLevel={sessionThinkingLevel}
                onChange={onSessionModelSettingsChange}
                modelInputRef={modelInputRef}
              />
            )}
            <SessionMcpServers
              agentServers={agent.mcp_servers ?? []}
              // Enabling a server changes the agent's live tool set, which the
              // agent payload carries.
              onServersChanged={refetch}
            />
            <SessionTools
              tools={agent.tools}
              mcpServers={agent.mcp_servers ?? []}
            />
          </>
        )}
      </div>

      {/* Keyboard hints only: phones have neither Esc nor the shortcut. */}
      <div className="hidden shrink-0 border-t border-(--color-border) bg-(--bg-card) px-3 py-2.5 sm:px-5 md:block">
        <p className="text-[11px] text-(--color-text-muted)">
          Esc or click outside to close · {shortcutLabel(APP_SHORTCUTS.sessionSettings, os)} to toggle
        </p>
      </div>
    </AppOverlay>
  )
}

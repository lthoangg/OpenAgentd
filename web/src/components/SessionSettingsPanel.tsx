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
import { OVERLAY_BODY } from '@/components/ui/panel-tokens'
import { Skeleton } from '@/components/ui/skeleton'
import { hasFinePointer } from '@/lib/pointer'
import { cn } from '@/lib/utils'
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
  const { data, isLoading, refetch } = useAgentsQuery(workspace)
  // Keyboard users land on the model field, not the close button. Touch users
  // don't: focusing it would pop the software keyboard over the settings.
  const modelInputRef = useRef<HTMLInputElement | null>(null)
  const focusModelField = hasFinePointer()

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
    if (!open || !hasContent || !focusModelField) return
    const id = requestAnimationFrame(() => modelInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, hasContent, focusModelField])

  return (
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Session settings"
      maxWidth="560px"
      initialFocus={focusModelField ? modelInputRef : undefined}
      toggleShortcut="sessionSettings"
    >
      <OverlayHeader
        title="Session settings"
        subtitle="Applies from your next message."
        onClose={onClose}
        closeLabel="Close (Esc)"
      />

      <div className={cn(OVERLAY_BODY, 'space-y-6 md:space-y-8')}>
        {isLoading || !agent ? (
          <div role="status" aria-label="Loading session settings" className="space-y-8">
            {[16, 24].map((h) => (
              <div key={h} className="space-y-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={h === 16 ? 'h-16' : 'h-24'} />
              </div>
            ))}
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

    </AppOverlay>
  )
}

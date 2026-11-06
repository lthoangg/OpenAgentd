import type { SessionResponse } from '@/api/types'
import { saveLastWorkspace } from '@/utils/workspace'

export function getFallbackSessionAfterDelete(
  deleteTarget: SessionResponse,
  currentSessionId: string | undefined,
  workspaceSessions: SessionResponse[],
): SessionResponse | null {
  if (deleteTarget.id !== currentSessionId) return null
  if (deleteTarget.parent_session_id) {
    const parent = workspaceSessions.find((s) => s.id === deleteTarget.parent_session_id)
    if (parent) return parent
  }
  return workspaceSessions.find((session) => session.id !== deleteTarget.id && session.workspace === deleteTarget.workspace)
    ?? workspaceSessions.find((session) => session.id !== deleteTarget.id)
    ?? null
}

export function applySessionSelection(options: {
  session: SessionResponse
  workspacePath: string
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  onMobileClose?: () => void
}): void {
  const workspace = options.session.workspace ?? options.workspacePath
  if (workspace) saveLastWorkspace(workspace)
  options.navigate({
    to: '/$sessionId',
    params: { sessionId: options.session.id },
  })
  options.onMobileClose?.()
}

export function applySessionDelete(options: {
  deleteTarget: SessionResponse
  currentSessionId: string | undefined
  workspaceSessions: SessionResponse[]
  /**
   * Delete without leaving the screen: the session is not on display (the
   * phone's Sessions list over a chat kept beneath it), so no fallback opens.
   */
  stay?: boolean
  mutateDelete: (target: string | { id: string; parent_session_id?: string | null }) => void
  navigate: (args: { to: string; params?: { sessionId: string }; replace: true }) => void
}): void {
  const fallbackSession = getFallbackSessionAfterDelete(
    options.deleteTarget,
    options.currentSessionId,
    options.workspaceSessions,
  )
  options.mutateDelete(
    options.deleteTarget.parent_session_id
      ? { id: options.deleteTarget.id, parent_session_id: options.deleteTarget.parent_session_id }
      : options.deleteTarget.id,
  )
  if (options.stay || options.deleteTarget.id !== options.currentSessionId) return
  if (fallbackSession) {
    if (fallbackSession.workspace) saveLastWorkspace(fallbackSession.workspace)
    options.navigate({
      to: '/$sessionId',
      params: { sessionId: fallbackSession.id },
      replace: true,
    })
    return
  }
  options.navigate({ to: '/', replace: true })
}

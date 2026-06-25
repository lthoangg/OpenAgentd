import type { SessionResponse } from '@/api/types'
import { saveLastCodingWorkspace } from '@/utils/workspace'

export function prepareSessionTitleUpdate(
  editTarget: SessionResponse | null,
  editTitle: string,
): { id: string; title: string } | null {
  if (!editTarget) return null
  const title = editTitle.trim()
  if (!title) return null
  return { id: editTarget.id, title }
}

export function getFallbackSessionAfterDelete(
  deleteTarget: SessionResponse,
  currentSessionId: string | undefined,
  codingSessions: SessionResponse[],
): SessionResponse | null {
  if (deleteTarget.id !== currentSessionId) return null
  return codingSessions.find((session) => session.id !== deleteTarget.id && session.workspace === deleteTarget.workspace)
    ?? codingSessions.find((session) => session.id !== deleteTarget.id)
    ?? null
}

export function applySessionSelection(options: {
  session: SessionResponse
  workspacePath: string
  navigate: (args: { to: string; params: { sessionId: string } }) => void
  onMobileClose?: () => void
}): void {
  const workspace = options.session.workspace ?? options.workspacePath
  if (workspace) saveLastCodingWorkspace(workspace)
  options.navigate({
    to: '/coding/$sessionId',
    params: { sessionId: options.session.id },
  })
  options.onMobileClose?.()
}

export function applySessionDelete(options: {
  deleteTarget: SessionResponse
  currentSessionId: string | undefined
  codingSessions: SessionResponse[]
  mutateDelete: (id: string) => void
  navigate: (args: { to: string; params?: { sessionId: string }; replace: true }) => void
}): void {
  const fallbackSession = getFallbackSessionAfterDelete(
    options.deleteTarget,
    options.currentSessionId,
    options.codingSessions,
  )
  options.mutateDelete(options.deleteTarget.id)
  if (options.deleteTarget.id !== options.currentSessionId) return
  if (fallbackSession) {
    if (fallbackSession.workspace) saveLastCodingWorkspace(fallbackSession.workspace)
    options.navigate({
      to: '/coding/$sessionId',
      params: { sessionId: fallbackSession.id },
      replace: true,
    })
    return
  }
  options.navigate({ to: '/coding', replace: true })
}

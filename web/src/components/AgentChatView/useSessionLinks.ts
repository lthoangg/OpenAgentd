/**
 * Opening another session from this chat: the other end of a workspace
 * message (its chip, a reply report, or the ``workspace`` tool card by
 * event), and a subagent's way back to its lead.
 */
import { useCallback, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { saveLastWorkspace } from '@/utils/workspace'
import { OPEN_SESSION_EVENT, isOpenSessionRequest } from '@/utils/workspace-messages'

export function useSessionLinks(parentSessionId: string | null) {
  const navigate = useNavigate()
  // The other end of a workspace message: the sender's session from the
  // request's chip, the replier's session from a reply report.
  const handleOpenSession = useCallback((targetSessionId: string, targetWorkspace: string) => {
    if (targetWorkspace) saveLastWorkspace(targetWorkspace)
    navigate({ to: '/$sessionId', params: { sessionId: targetSessionId } })
  }, [navigate])
  // From a subagent's session back to the lead's: the header button and the
  // "Return to main agent" banner share it.
  const handleOpenLead = useCallback(() => {
    if (parentSessionId) navigate({ to: '/$sessionId', params: { sessionId: parentSessionId } })
  }, [navigate, parentSessionId])
  // The ``workspace`` tool card asks for the same switch by event,
  // which keeps ToolCall free of the router.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<unknown>).detail
      if (isOpenSessionRequest(request)) handleOpenSession(request.sessionId, request.workspace)
    }
    window.addEventListener(OPEN_SESSION_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SESSION_EVENT, onOpen)
  }, [handleOpenSession])

  return { handleOpenSession, handleOpenLead }
}

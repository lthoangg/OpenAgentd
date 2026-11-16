/**
 * What a session row can do, from any of the sidebar's lists: open (⌘-click
 * in a new desktop window), rename in place, pin, and delete with a toast
 * that can undo it. One list of actions feeds the row's ⋯ menu, right-click
 * and the phone's long-press sheet.
 */
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AppWindow, Pencil, Pin, PinOff, Trash2, type LucideIcon } from 'lucide-react'
import type { SessionResponse } from '@/api/types'
import { usePlatform } from '@/hooks/use-platform'
import { isMobileApp } from '@/lib/mobile-app'
import { sessionWorking } from '@/lib/active-sessions'
import {
  useDeleteSessionMutation,
  useSetSessionPinnedMutation,
  useUpdateSessionTitleMutation,
} from '@/queries/useSessionsQuery'
import { useToastStore } from '@/stores/useToastStore'
import { applySessionDelete, applySessionSelection } from './sessions'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from './window'

/** How long a deleted session can be brought back before the server forgets it. */
const SESSION_DELETE_UNDO_MS = 10_000

/** One entry of a session's menu (⋯, right-click, the phone's sheet). */
interface SessionMenuAction {
  id: string
  label: string
  icon: LucideIcon
  danger?: boolean
  /** Starts a new group of entries. */
  separatorBefore?: boolean
  run: () => void
}

export type SessionActions = ReturnType<typeof useSessionActions>

export function useSessionActions({
  currentSessionId,
  workspaceSessions,
  isMobile,
  isPage,
  mobileOpen,
  onMobileClose,
}: {
  currentSessionId?: string
  /** Every loaded session with a workspace: where a deleted current one falls back to. */
  workspaceSessions: SessionResponse[]
  isMobile: boolean
  /** The phone's Sessions page, which keeps a chat under the list. */
  isPage: boolean
  mobileOpen: boolean
  onMobileClose?: () => void
}) {
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isMobileApp({ isTauri, os })
  const navigate = useNavigate()
  const pushToast = useToastStore((s) => s.push)
  const dismissToast = useToastStore((s) => s.dismiss)
  const deleteSession = useDeleteSessionMutation()
  const updateSessionTitle = useUpdateSessionTitleMutation()
  const setSessionPinned = useSetSessionPinnedMutation()
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionResponse | null>(null)
  const [mobileSessionActions, setMobileSessionActions] = useState<{ session: SessionResponse } | null>(null)
  const [desktopSessionActions, setDesktopSessionActions] = useState<{ session: SessionResponse; x: number; y: number } | null>(null)

  const toggleSessionPinned = (session: SessionResponse) => {
    const pinned = !session.pinned_at
    setSessionPinned.mutate(
      { id: session.id, pinned },
      { onError: () => pushToast({ tone: 'error', title: pinned ? "Couldn't pin session" : "Couldn't unpin session" }) },
    )
  }

  const openInNewWindow = (session: SessionResponse) => {
    openSessionInNewWindow({ session }).catch((err) => {
      console.error("Couldn't open session in new window:", err)
      pushToast({
        tone: 'error',
        title: "Couldn't open session in new window",
        description: sessionWindowErrorDescription(err, 'Desktop window creation failed.'),
      })
    })
  }

  const handleSessionSelect = (session: SessionResponse, workspacePath: string, event?: React.MouseEvent) => {
    if (event && shouldOpenSessionInNewWindow(event, isTauri, os)) {
      event.preventDefault()
      event.stopPropagation()
      openInNewWindow(session)
      return
    }

    applySessionSelection({
      session,
      workspacePath,
      navigate,
      onMobileClose,
    })
  }

  // From a row's key (an event) or its swipe action (none).
  const handleSessionDelete = (e: React.SyntheticEvent | null, session: SessionResponse) => {
    e?.stopPropagation()
    requestSessionDelete(session)
  }

  const handleSessionEdit = (session: SessionResponse) => {
    setEditingSessionId(session.id)
  }

  const handleSessionRename = (session: SessionResponse, title: string) => {    setEditingSessionId(null)
    updateSessionTitle.mutate(
      { id: session.id, title },
      { onError: () => pushToast({ tone: 'error', title: "Couldn't rename session" }) },
    )
  }

  // Row callbacks shared by every session list (tree, flat views, Pinned).
  const sessionRowHandlers = {
    onSessionSelect: handleSessionSelect,
    onSessionDelete: handleSessionDelete,
    onSessionEdit: handleSessionEdit,
    onSessionRename: handleSessionRename,
    onSessionRenameCancel: () => setEditingSessionId(null),
    onSessionLongPress: (session: SessionResponse) => setMobileSessionActions({ session }),
    onSessionContextActions: (session: SessionResponse, event: { clientX: number; clientY: number }) => {
      // Phones (browser too): the titled sheet, since a truncated title has
      // no tooltip on touch.
      if (isMobile) {
        setMobileSessionActions({ session })
        return
      }
      setDesktopSessionActions({ session, x: event.clientX, y: event.clientY })
    },
    onSessionPinToggle: toggleSessionPinned,
  }

  // One list for a session's ⋯ menu, right-click and the phone's sheet.
  const sessionMenuActions = (session: SessionResponse): SessionMenuAction[] => {
    // Subagents are their parent's: no pin, and their title is their task.
    const topLevel = !session.parent_session_id
    const actions: SessionMenuAction[] = []
    if (isTauri && !isTauriMobile) {
      actions.push({ id: 'window', label: 'Open in new window', icon: AppWindow, run: () => openInNewWindow(session) })
    }
    if (topLevel) {
      actions.push({ id: 'rename', label: 'Rename', icon: Pencil, run: () => handleSessionEdit(session) })
      actions.push({
        id: 'pin',
        label: session.pinned_at ? 'Unpin' : 'Pin',
        icon: session.pinned_at ? PinOff : Pin,
        run: () => toggleSessionPinned(session),
      })
    }
    // The ellipsis says a dialog follows, which only a working session gets.
    actions.push({ id: 'delete', label: sessionWorking(session) ? 'Delete session…' : 'Delete session', icon: Trash2, danger: true, separatorBefore: actions.length > 0, run: () => requestSessionDelete(session) })
    return actions
  }

  // Undo or confirm, not both (DESIGN.md): the toast's Undo covers a delete,
  // so only a session whose agent is still working asks first. Undo brings
  // the session back but does not restart a stopped turn.
  function requestSessionDelete(session: SessionResponse) {
    if (sessionWorking(session)) setDeleteTarget(session)
    else deleteSessionNow(session)
  }

  const confirmSessionDelete = () => {
    if (!deleteTarget) return
    deleteSessionNow(deleteTarget)
    setDeleteTarget(null)
  }

  function deleteSessionNow(target: SessionResponse) {
    // On the Sessions page, ``currentSessionId`` is the chat kept under the
    // list, not one on screen: deleting it neither leaves for another session
    // (that would push a chat over Sessions) nor, on Undo, goes back to it.
    const stay = isPage && mobileOpen
    const wasOpen = !stay && target.id === currentSessionId
    // The row leaves at once; the server delete waits out the Undo window.
    // Undo (or a refusal) brings the row back.
    const undo = new AbortController()
    const toastId = pushToast({
      tone: 'info',
      title: 'Session deleted',
      description: target.title || 'Untitled',
      action: {
        label: 'Undo',
        onAction: () => {
          undo.abort()
          if (wasOpen) navigate({ to: '/$sessionId', params: { sessionId: target.id }, replace: true })
        },
      },
    }, SESSION_DELETE_UNDO_MS)
    applySessionDelete({
      deleteTarget: target,
      currentSessionId,
      workspaceSessions,
      stay,
      mutateDelete: (mutationTarget) => deleteSession.mutate(
        typeof mutationTarget === 'string'
          ? { id: mutationTarget, holdMs: SESSION_DELETE_UNDO_MS, undo: undo.signal }
          : { ...mutationTarget, holdMs: SESSION_DELETE_UNDO_MS, undo: undo.signal },
        {
          // Past the window the Undo button can't help any more.
          onSettled: () => dismissToast(toastId),
          onError: () => {
            if (undo.signal.aborted) return
            pushToast({ tone: 'error', title: "Couldn't delete session" })
          },
        },
      ),
      navigate,
    })
  }

  return {
    editingSessionId,
    deleteTarget,
    setDeleteTarget,
    confirmSessionDelete,
    mobileSessionActions,
    setMobileSessionActions,
    desktopSessionActions,
    setDesktopSessionActions,
    sessionMenuActions,
    sessionRowHandlers,
    handleSessionSelect,
  }
}

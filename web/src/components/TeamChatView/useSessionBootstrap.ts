/**
 * useSessionBootstrap — session lifecycle wiring for TeamChatView.
 *
 * Owns:
 *   - Mount-time SSE connect + session restore (carefully sequenced so
 *     ``loadSession`` runs *before* ``connectStream`` to avoid wiping
 *     replayed mid-turn state — see the comment inside the init effect).
 *   - Reconnect-on-visibility (tab refocus / ``pageshow``) so a
 *     backgrounded tab picks the stream back up.
 *   - Per-session composer drafts (kept in a ref keyed by session id so
 *     switching sessions restores the right unsent text).
 *   - ``handleNewSession`` — creates (or reuses) a session and navigates
 *     to it.
 *   - The desktop tray label (a no-op outside Tauri).
 *   - Composer-focus plumbing: the ``focus-chat-input`` custom event, the
 *     bare-character-starts-typing shortcut, and the ``queue:restore-draft``
 *     / ``undo:restore-draft`` custom events that repopulate the composer
 *     from the queued-message and undo affordances elsewhere in the tree.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { resolveTeamSession } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { saveLastCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { setTraySession } from '@/lib/tray'
import { isEditableTarget } from '@/lib/is-editable-target'
import { attachmentToFile } from './helpers'
import type { InputBarHandle } from '../InputBar'
import type { MessageAttachment } from '@/api/types'

interface SessionDraft {
  value: string
}

export interface UseSessionBootstrapArgs {
  sessionId?: string
  mode: 'normal' | 'coding'
  workspace: string | null
  agentWorkspace: string | null
  hasCodingWorkspace: boolean
  isCodingSessionLoading: boolean
  isMobile: boolean
  paletteOpen: boolean
  sessionIdState: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  sessionTitle: string | null
  isTeamWorking: boolean
  inputRef: RefObject<InputBarHandle | null>
  navigate: ReturnType<typeof useNavigate>
  queryClient: QueryClient
  connectStream: () => AbortController
  loadTeamStatus: (workspace?: string | null) => Promise<void>
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  beginResolvedSession: (sessionId: string | null, options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; skipInitialRestore?: boolean }) => void
  consumeResolvedSessionReady: (sessionId: string, workspace?: string | null) => boolean
}

export interface UseSessionBootstrapResult {
  isEmptyIdleSession: () => boolean
  handleNewSession: () => void
  handleDraftValueChange: (value: string) => void
  handleAddFileComment: (path: string, startLine: number, endLine: number) => void
}

export function useSessionBootstrap({
  sessionId,
  mode,
  workspace,
  agentWorkspace,
  hasCodingWorkspace,
  isCodingSessionLoading,
  isMobile,
  paletteOpen,
  sessionIdState,
  sessionModel,
  sessionThinkingLevel,
  sessionTitle,
  isTeamWorking,
  inputRef,
  navigate,
  queryClient,
  connectStream,
  loadTeamStatus,
  loadSession,
  beginResolvedSession,
  consumeResolvedSessionReady,
}: UseSessionBootstrapArgs): UseSessionBootstrapResult {
  const draftBySessionRef = useRef<Record<string, SessionDraft>>({})
  const abortRef = useRef<AbortController | null>(null)

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (hasCodingWorkspace) loadTeamStatus(agentWorkspace)
    if (isCodingSessionLoading) return
    if (!sessionId) return
    const store = useTeamStore.getState()
    if (store.sessionId === sessionId && store.isConnected) return

    useTeamStore.setState({ sessionId })

    const draft = draftBySessionRef.current[sessionId]
    inputRef.current?.setValue(draft?.value ?? '')
    inputRef.current?.setFiles([])

    // Order matters: load prior-turn history FIRST, then open the SSE.
    //
    // Before this ordering, `connectStream()` started SSE replay (which
    // writes synthetic thinking/message events into `currentBlocks`)
    // while `loadSession()` was still inflight. When `loadSession`
    // resolved it unconditionally set `currentBlocks = []`, wiping the
    // replayed state. On mid-turn refresh the UI looked blank until the
    // next live chunk arrived — often until `done`.
    //
    // Awaiting the DB read first means `loadSession` has already committed
    // `blocks` and emptied `currentBlocks` by the time any SSE event is
    // dispatched, so replay + live events accumulate cleanly.
    let cancelled = false
    ;(async () => {
      if (!consumeResolvedSessionReady(sessionId, agentWorkspace)) {
        await loadSession(sessionId, agentWorkspace)
      }
      if (cancelled) return
      const controller = connectStream()
      if (controller) abortRef.current = controller
    })()

    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentWorkspace, hasCodingWorkspace, isCodingSessionLoading])

  useEffect(() => {
    if (!sessionId) return

    const resumeStream = () => {
      const state = useTeamStore.getState()
      if (state.sessionId !== sessionId) return
      if (state._workspace !== agentWorkspace) return
      if (state.isConnected && !state._unloading) return

      useTeamStore.setState({ _unloading: false })
      if (state.isTeamWorking) {
        void loadSession(sessionId, agentWorkspace).then(() => {
          const current = useTeamStore.getState()
          if (current.sessionId !== sessionId || current._workspace !== agentWorkspace) return
          abortRef.current = connectStream()
        })
      } else {
        abortRef.current = connectStream()
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resumeStream()
    }

    window.addEventListener('pageshow', resumeStream)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pageshow', resumeStream)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentWorkspace])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const isEmptyIdleSession = useCallback(() => useTeamStore.getState().isEmptyIdleSession(), [])

  const handleNewSession = useCallback(() => {
    if (isEmptyIdleSession()) return
    abortRef.current?.abort()
    abortRef.current = null
    // Eagerly delete the current session's draft before beginResolvedSession
    // resets store.sessionId to null. The InputBar's onValueChange('') effect
    // fires asynchronously after setValue(''), so by the time it calls
    // handleDraftValueChange the session id is already gone and the delete
    // never happens — leaving the old '/new' text to reappear on switch-back.
    const departingSessionId = useTeamStore.getState().sessionId
    if (departingSessionId) delete draftBySessionRef.current[departingSessionId]
    inputRef.current?.setValue('')
    inputRef.current?.setFiles([])
    ;(async () => {
      try {
        const sessionOptions = {
          mode,
          workspace: mode === 'coding' ? workspace : null,
          model: sessionIdState ? sessionModel : null,
          thinkingLevel: sessionIdState ? sessionThinkingLevel : null,
        }
        beginResolvedSession(null, sessionOptions)
        const session = await resolveTeamSession({
          ...sessionOptions,
          create: true,
        })
        beginResolvedSession(session.id, {
          mode,
          workspace: session.workspace ?? workspace,
          model: session.model ?? sessionModel,
          thinkingLevel: session.thinking_level ?? sessionThinkingLevel,
          skipInitialRestore: session.created,
        })
        if (session.created) {
          prependSession(queryClient, session)
        }
        if (mode === 'coding' && workspace) {
          if (session.created) prependWorkspaceSession(queryClient, workspace, session)
          saveLastCodingWorkspace(workspace)
          navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
        } else {
          navigate({ to: '/cockpit/$sessionId', params: { sessionId: session.id } })
        }
      } catch (err) {
        useTeamStore.setState((state) => {
          state.error = err instanceof Error ? err.message : 'Failed to create session'
        })
      }
    })()
  }, [beginResolvedSession, isEmptyIdleSession, mode, navigate, queryClient, sessionIdState, sessionModel, sessionThinkingLevel, workspace])

  // Focus the chat input. Callable directly (shortcut / Command Palette)
  // or indirectly via `window.dispatchEvent(new CustomEvent('focus-chat-input'))`
  // — the latter decouples future callers (buttons elsewhere, other views)
  // from this component's ref.
  const handleDraftValueChange = useCallback((value: string) => {
    const currentSessionId = useTeamStore.getState().sessionId
    if (!currentSessionId) return
    if (value) {
      draftBySessionRef.current[currentSessionId] = { value }
      return
    }
    delete draftBySessionRef.current[currentSessionId]
  }, [])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [inputRef])

  useEffect(() => {
    const handler = () => focusInput()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [focusInput])

  useEffect(() => {
    if (isMobile || paletteOpen || (mode === 'coding' && (!workspace || isCodingSessionLoading))) return

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length !== 1 || e.key.trim().length === 0) return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.insertText(e.key)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isCodingSessionLoading, isMobile, mode, paletteOpen, workspace, inputRef])

  const handleAddFileComment = useCallback((path: string, startLine: number, endLine: number) => {
    const ref = startLine === endLine ? `@${path}#L${startLine}` : `@${path}#L${startLine}-L${endLine}`
    inputRef.current?.appendValue(`${ref} `)
    inputRef.current?.focus()
  }, [inputRef])

  // Restore a queued message's text into the composer (fired by the
  // X button on PendingMessageQueue). Overwrites any current draft —
  // matches the /undo restore semantics above.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content?: string }>).detail
      const content = detail?.content ?? ''
      inputRef.current?.setValue(content)
      inputRef.current?.focus()
    }
    window.addEventListener('queue:restore-draft', handler)
    return () => window.removeEventListener('queue:restore-draft', handler)
  }, [inputRef])

  // Restore an undone message into the composer (fired by the undo button on
  // UserBubble in AgentView/AgentPane, which cannot access inputRef directly).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content?: string; attachments?: MessageAttachment[] }>).detail
      const content = detail?.content ?? ''
      const attachments = detail?.attachments ?? []
      inputRef.current?.setValue(content)
      void Promise.all(attachments.map((att) => attachmentToFile(att)))
        .then((files) => {
          inputRef.current?.setFiles(files.filter((f): f is File => f !== null))
          inputRef.current?.focus()
        })
    }
    window.addEventListener('undo:restore-draft', handler)
    return () => window.removeEventListener('undo:restore-draft', handler)
  }, [inputRef])

  // Push the active session/workspace label to the desktop tray. The
  // command is a no-op outside Tauri so this is safe to fire from the
  // web build too.
  //
  // Label priority — the tray reflects *liveness first*, then identity:
  //   - team currently responding → ``"Working: <ws-or-title>"``
  //     (falls back to ``"Working…"`` when no title yet — e.g. the
  //     team is generating the first message of a brand-new chat)
  //   - coding mode with workspace → ``"Coding: <ws>"``
  //   - chat with server-named session → ``"Chat: <title>"``
  //   - everything else → empty (tray shows ``No active session``)
  useEffect(() => {
    let label = ''
    const identity = mode === 'coding' && workspace
      ? workspaceLabel(workspace)
      : sessionTitle ?? ''
    if (isTeamWorking) {
      label = identity ? `Working: ${identity}` : 'Working…'
    } else if (mode === 'coding' && workspace) {
      label = `Coding: ${workspaceLabel(workspace)}`
    } else if (sessionTitle) {
      label = `Chat: ${sessionTitle}`
    }
    void setTraySession(label)
  }, [mode, workspace, sessionTitle, isTeamWorking])

  return {
    isEmptyIdleSession,
    handleNewSession,
    handleDraftValueChange,
    handleAddFileComment,
  }
}

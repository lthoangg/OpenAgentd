/**
 * useSessionBootstrap — session lifecycle wiring for AgentChatView.
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
import { resolveSession } from '@/api/client'
import { useAgentStore } from '@/stores/useAgentStore'
import { prependSession, prependWorkspaceSession } from '@/stores/cache-invalidation-bridge'
import { saveLastCodingWorkspace, workspaceLabel } from '@/utils/workspace'
import { setTraySession } from '@/lib/tray'
import { isEditableTarget } from '@/lib/is-editable-target'
import { attachmentToFile } from './helpers'
import { isDirectUserBlock } from '@/stores/useAgentStore/helpers'
import type { InputComposerHandle } from '../InputComposer'
import type { MessageAttachment } from '@/api/types'

interface SessionDraft {
  value: string
}

export interface UseSessionBootstrapArgs {
  sessionId?: string
  workspace: string | null
  agentWorkspace: string | null
  hasCodingWorkspace: boolean
  isCodingSessionLoading: boolean
  isMobile: boolean
  paletteOpen: boolean
  sessionModel: string | null
  sessionThinkingLevel: string | null
  sessionTitle: string | null
  isAgentWorking: boolean
  inputRef: RefObject<InputComposerHandle | null>
  navigate: ReturnType<typeof useNavigate>
  queryClient: QueryClient
  connectStream: () => AbortController
  loadAgentStatus: (workspace?: string | null) => Promise<void>
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  beginResolvedSession: (sessionId: string | null, options: { workspace: string; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; skipInitialRestore?: boolean }) => void
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
  workspace,
  agentWorkspace,
  hasCodingWorkspace,
  isCodingSessionLoading,
  isMobile,
  paletteOpen,
  sessionModel,
  sessionThinkingLevel,
  sessionTitle,
  isAgentWorking,
  inputRef,
  navigate,
  queryClient,
  connectStream,
  loadAgentStatus,
  loadSession,
  beginResolvedSession,
  consumeResolvedSessionReady,
}: UseSessionBootstrapArgs): UseSessionBootstrapResult {
  const draftBySessionRef = useRef<Record<string, SessionDraft>>({})
  const abortRef = useRef<AbortController | null>(null)
  const resumeInFlightRef = useRef(false)

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (hasCodingWorkspace) loadAgentStatus(agentWorkspace)
    if (isCodingSessionLoading) return
    if (!sessionId) return
    const store = useAgentStore.getState()
    if (abortRef.current && store.sessionId === sessionId && (store.isConnected || store.isAgentWorking)) return

    if (store.sessionId !== sessionId) {
      // Switching chats: reset through the store (aborts the old SSE, bumps
      // the session generation, clears the live turn) instead of patching the
      // id in place. Patching alone left the departing session's streaming
      // blocks, `isAgentWorking`, and agent status attached to the new id —
      // and because `loadSession` reads them as newer-than-the-fetch local
      // content, the previous chat's stream kept rendering here even after
      // this session's history arrived.
      if (!agentWorkspace) return
      beginResolvedSession(sessionId, { workspace: agentWorkspace })
    } else {
      useAgentStore.setState({ sessionId })
    }

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
      const store = useAgentStore.getState()
      const leadStream = store.leadName ? store.agentStreams[store.leadName] : undefined
      const hasDraft = Boolean(draftBySessionRef.current[sessionId]?.value?.trim())
      if (
        leadStream &&
        (leadStream.revertedCount ?? 0) > 0 &&
        leadStream.revertedMessages &&
        leadStream.revertedMessages.length > 0 &&
        inputRef.current &&
        !hasDraft
      ) {
        // `revertedMessages` is a display-only preview: every entry (including
        // a reverted `compaction` block) is normalized to `role: 'user'` so
        // RevertNotice can render it as a plain bubble — so it cannot be used
        // to find "the human's actual undone text" here. Read the raw reverted
        // blocks instead and use the same direct-user predicate the backend's
        // undo target and the revert count use, so a compaction block that
        // lands first in the reverted tail can't get restored into the
        // composer as if it were the user's draft.
        const undoneBlock = leadStream._revertedSuffix?.find(isDirectUserBlock)
        if (undoneBlock?.content || (undoneBlock?.attachments && undoneBlock.attachments.length > 0)) {
          inputRef.current.setValue(undoneBlock.content ?? '')
          if (undoneBlock.attachments && undoneBlock.attachments.length > 0) {
            void Promise.all(undoneBlock.attachments.map((att) => attachmentToFile(att)))
              .then((files) => {
                inputRef.current?.setFiles(files.filter((f): f is File => f !== null))
              })
          }
        }
      }
      const controller = connectStream()
      if (controller) abortRef.current = controller
    })()

    return () => {
      cancelled = true
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [
    sessionId,
    agentWorkspace,
    hasCodingWorkspace,
    isCodingSessionLoading,
    loadAgentStatus,
    beginResolvedSession,
    consumeResolvedSessionReady,
    loadSession,
    connectStream,
    inputRef,
  ])

  useEffect(() => {
    if (!sessionId) return

    const resumeStream = () => {
      const state = useAgentStore.getState()
      if (state.sessionId !== sessionId) return
      if (state._workspace !== agentWorkspace) return
      if (resumeInFlightRef.current) return

      // On desktop or browser builds, a localhost SSE connection remains alive
      // while backgrounded. If connected and an active turn is in flight, do
      // not abort the stream or clobber in-flight tool cards and text.
      if (!isMobile && state.isConnected && (state.isAgentWorking || abortRef.current !== null)) {
        return
      }

      // Mobile webviews may freeze a fetch-based SSE connection while the app
      // is backgrounded without closing it. In that case isConnected remains
      // true even though the stream can no longer deliver events. Always
      // reconcile persisted history and replace the stream on foreground.
      resumeInFlightRef.current = true
      abortRef.current?.abort()
      state._abortController?.abort()
      useAgentStore.setState({ _unloading: false, isConnected: false, _abortController: null })
      void loadSession(sessionId, agentWorkspace).then(() => {
        const current = useAgentStore.getState()
        if (current.sessionId !== sessionId || current._workspace !== agentWorkspace) return
        if (current.isAgentWorking) abortRef.current = connectStream()
      }).finally(() => {
        resumeInFlightRef.current = false
      })
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
  }, [sessionId, agentWorkspace, isMobile, loadSession, connectStream])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const isEmptyIdleSession = useCallback(() => useAgentStore.getState().isEmptyIdleSession(), [])

  const handleNewSession = useCallback(() => {
    if (!workspace) return
    if (isEmptyIdleSession()) return
    abortRef.current?.abort()
    abortRef.current = null
    // Eagerly delete the current session's draft before beginResolvedSession
    // resets store.sessionId to null. The InputComposer's onValueChange('') effect
    // fires asynchronously after setValue(''), so by the time it calls
    // handleDraftValueChange the session id is already gone and the delete
    // never happens — leaving the old '/new' text to reappear on switch-back.
    const departingSessionId = useAgentStore.getState().sessionId
    if (departingSessionId) delete draftBySessionRef.current[departingSessionId]
    inputRef.current?.setValue('')
    inputRef.current?.setFiles([])
    ;(async () => {
      try {
        const sessionOptions = {
          workspace,
          model: sessionModel,
          thinkingLevel: sessionThinkingLevel,
        }
        beginResolvedSession(null, sessionOptions)
        const session = await resolveSession({
          ...sessionOptions,
          create: true,
        })
        // Re-read live state: the user may have changed the session model or
        // thinking level (via Session Settings) while this request was in
        // flight. Falling back to the props captured when "New session" was
        // clicked would silently discard that choice.
        const latest = useAgentStore.getState()
        beginResolvedSession(session.id, {
          workspace: session.workspace ?? workspace,
          model: session.model ?? latest.sessionModel,
          thinkingLevel: session.thinking_level ?? latest.sessionThinkingLevel,
          skipInitialRestore: session.created,
        })
        if (session.created) {
          prependSession(queryClient, session)
        }
        if (session.created) prependWorkspaceSession(queryClient, workspace, session)
        saveLastCodingWorkspace(workspace)
        navigate({ to: '/coding/$sessionId', params: { sessionId: session.id } })
      } catch (err) {
        useAgentStore.setState((state) => {
          state.error = err instanceof Error ? err.message : 'Failed to create session'
        })
      }
    })()
  }, [beginResolvedSession, inputRef, isEmptyIdleSession, navigate, queryClient, sessionModel, sessionThinkingLevel, workspace])

  // Focus the chat input. Callable directly (shortcut / Command Palette)
  // or indirectly via `window.dispatchEvent(new CustomEvent('focus-chat-input'))`
  // — the latter decouples future callers (buttons elsewhere, other views)
  // from this component's ref.
  const handleDraftValueChange = useCallback((value: string) => {
    const currentSessionId = useAgentStore.getState().sessionId
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
    if (isMobile || paletteOpen || !workspace || isCodingSessionLoading) return

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
  }, [isCodingSessionLoading, isMobile, paletteOpen, workspace, inputRef])

  const handleAddFileComment = useCallback((path: string, startLine: number, endLine: number) => {
    const ref = startLine === endLine ? `@${path}#L${startLine}` : `@${path}#L${startLine}-L${endLine}`
    inputRef.current?.appendValue(`${ref} `)
    inputRef.current?.focus()
  }, [inputRef])

  // Restore a queued message's text and files into the composer (fired by
  // the X button on PendingMessageQueue). Overwrites any current draft —
  // matches the /undo restore semantics above. Files come back as the
  // original File objects kept on the pending message, since cancelling
  // deletes the persisted uploads server-side.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content?: string; files?: File[] }>).detail
      const content = detail?.content ?? ''
      inputRef.current?.setValue(content)
      inputRef.current?.setFiles(detail?.files ?? [])
      inputRef.current?.focus()
    }
    window.addEventListener('queue:restore-draft', handler)
    return () => window.removeEventListener('queue:restore-draft', handler)
  }, [inputRef])

  // Restore an undone message into the composer (fired by the undo button on
  // UserBubble in AgentView/AgentPane, which cannot access inputRef directly).
  const pendingDraft = useAgentStore((s) => s.pendingDraft)
  const consumePendingDraft = useAgentStore((s) => s.consumePendingDraft)
  useEffect(() => {
    if (!pendingDraft) return
    const draft = consumePendingDraft()
    if (!draft) return
    inputRef.current?.setValue(draft.content)
    void Promise.all((draft.attachments || []).map((att) => attachmentToFile(att)))
      .then((files) => {
        inputRef.current?.setFiles(files.filter((f): f is File => f !== null))
        inputRef.current?.focus()
      })
  }, [pendingDraft, consumePendingDraft, inputRef])

  // Fallback for custom events (backwards compatibility / external dispatch)
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
  //   - agent currently responding → ``"Working: <ws-or-title>"``
  //     (falls back to ``"Working…"`` when no title yet — e.g. the
  //     agent is generating the first message of a brand-new chat)
  //   - coding mode with workspace → ``"Coding: <ws>"``
  //   - chat with server-named session → ``"Chat: <title>"``
  //   - everything else → empty (tray shows ``No active session``)
  useEffect(() => {
    let label = ''
    const identity = workspace ? workspaceLabel(workspace) : sessionTitle ?? ''
    if (isAgentWorking) {
      label = identity ? `Working: ${identity}` : 'Working…'
    } else if (workspace) {
      label = `Coding: ${workspaceLabel(workspace)}`
    }
    void setTraySession(label)
  }, [workspace, sessionTitle, isAgentWorking])

  return {
    isEmptyIdleSession,
    handleNewSession,
    handleDraftValueChange,
    handleAddFileComment,
  }
}

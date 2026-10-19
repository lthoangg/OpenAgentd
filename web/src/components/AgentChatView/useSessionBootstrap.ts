/**
 * useSessionBootstrap — session lifecycle wiring for AgentChatView.
 *
 * Owns:
 *   - Mount-time SSE connect + session restore (carefully sequenced so
 *     ``loadSession`` runs *before* ``connectStream`` to avoid wiping
 *     replayed mid-turn state — see the comment inside the init effect).
 *   - Reconnect-on-visibility (tab refocus / ``pageshow``) so a
 *     backgrounded tab picks the stream back up.
 *   - Per-session composer drafts (keyed by session id, or ``draft:<path>``
 *     on a new-session draft, so switching restores the right unsent text).
 *   - ``handleNewSession`` — opens a new-session draft for the workspace
 *     (``lib/new-session``); the first message creates the session.
 *   - The desktop tray label (a no-op outside Tauri).
 *   - Composer-focus plumbing: the ``focus-chat-input`` custom event, the
 *     bare-character-starts-typing shortcut, and the ``queue:restore-draft``
 *     / ``undo:restore-draft`` custom events that repopulate the composer
 *     from the queued-message and undo affordances elsewhere in the tree.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { useNavigate } from '@tanstack/react-router'
import { useAgentStore } from '@/stores/useAgentStore'
import { workspaceLabel } from '@/utils/workspace'
import { draftComposerKey, startNewSession } from '@/lib/new-session'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { setTraySession } from '@/lib/tray'
import { isEditableTarget } from '@/lib/is-editable-target'
import { attachmentToFile } from './helpers'
import { backgroundSuspendsSockets } from '@/hooks/use-platform'
import { isDirectUserBlock } from '@/stores/useAgentStore/helpers'
import { topBlockingLayer } from '@/lib/keyboard/layers'
import { createPersistedDraftMap } from '@/lib/persisted-drafts'
import type { InputComposerHandle } from '../InputComposer'
import type { MessageAttachment } from '@/api/types'

interface SessionDraft {
  value: string
}

/**
 * Composer text per session. Persisted so a reload or a renderer crash does
 * not lose a half-written prompt (attachments are not: they are `File`s).
 */
const composerDrafts = createPersistedDraftMap<SessionDraft>({ storageKey: 'oa.drafts.composer.v1', max: 50 })

export interface UseSessionBootstrapArgs {
  sessionId?: string
  workspace: string | null
  /** Chat entry from the workspace tree — labels the tray as "Chat". */
  chatWorkspace?: { path: string; name: string } | null
  agentWorkspace: string | null
  hasWorkspace: boolean
  isSessionLoading: boolean
  isMobile: boolean
  paletteOpen: boolean
  sessionTitle: string | null
  isAgentWorking: boolean
  inputRef: RefObject<InputComposerHandle | null>
  navigate: ReturnType<typeof useNavigate>
  connectStream: () => AbortController
  loadAgentStatus: (workspace?: string | null, expectedGeneration?: number, sessionId?: string | null) => Promise<void>
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
  chatWorkspace = null,
  agentWorkspace,
  hasWorkspace,
  isSessionLoading,
  isMobile,
  paletteOpen,
  sessionTitle,
  isAgentWorking,
  inputRef,
  navigate,
  connectStream,
  loadAgentStatus,
  loadSession,
  beginResolvedSession,
  consumeResolvedSessionReady,
}: UseSessionBootstrapArgs): UseSessionBootstrapResult {
  const abortRef = useRef<AbortController | null>(null)
  const resumeInFlightRef = useRef(false)

  // ── Init / reconnect ───────────────────────────────────────────────────────

  useEffect(() => {
    // The route's session, not the store's: the store still holds the
    // previous chat until `beginResolvedSession` below runs.
    if (hasWorkspace) loadAgentStatus(agentWorkspace, undefined, sessionId ?? null)
    if (isSessionLoading) return
    if (!sessionId) return
    const store = useAgentStore.getState()
    const activeController =
      abortRef.current && !abortRef.current.signal.aborted
        ? abortRef.current
        : store._abortController && !store._abortController.signal.aborted
          ? store._abortController
          : null
    if (
      activeController &&
      store.sessionId === sessionId &&
      (store.isConnected || store.isAgentWorking)
    ) {
      abortRef.current = activeController
      return
    }

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

    const draft = composerDrafts.get(sessionId)
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
      const hasDraft = Boolean(composerDrafts.get(sessionId)?.value?.trim())
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
      if (abortRef.current && !abortRef.current.signal.aborted) {
        abortRef.current.abort()
      }
      abortRef.current = null
    }
  }, [
    sessionId,
    agentWorkspace,
    hasWorkspace,
    isSessionLoading,
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

      // On desktop, a localhost SSE connection remains alive while
      // backgrounded. If connected and an active turn is in flight, do not
      // abort the stream or clobber in-flight tool cards and text. Keyed on
      // the OS, not the viewport: a narrow desktop window keeps its sockets.
      const active =
        abortRef.current && !abortRef.current.signal.aborted
          ? abortRef.current
          : state._abortController && !state._abortController.signal.aborted
            ? state._abortController
            : null
      if (
        !backgroundSuspendsSockets() &&
        state.isConnected &&
        (state.isAgentWorking || active !== null)
      ) {
        return
      }

      // Mobile webviews may freeze a fetch-based SSE connection while the app
      // is backgrounded without closing it. In that case isConnected remains
      // true even though the stream can no longer deliver events. Always
      // reconcile persisted history and replace the stream on foreground.
      resumeInFlightRef.current = true
      active?.abort()
      abortRef.current?.abort()
      state._abortController?.abort()
      abortRef.current = null
      useAgentStore.setState({ _unloading: false, isConnected: false, _abortController: null })
      void loadSession(sessionId, agentWorkspace).then(() => {
        const current = useAgentStore.getState()
        if (current.sessionId !== sessionId || current._workspace !== agentWorkspace) return
        if (current.isAgentWorking) {
          const controller = connectStream()
          if (controller) abortRef.current = controller
        }
      }).finally(() => {
        resumeInFlightRef.current = false
      })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resumeStream()
    }

    window.addEventListener('online', resumeStream)
    window.addEventListener('pageshow', resumeStream)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', resumeStream)
      window.removeEventListener('pageshow', resumeStream)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [sessionId, agentWorkspace, loadSession, connectStream])

  // ── Commands / shortcuts ───────────────────────────────────────────────────

  const isEmptyIdleSession = useCallback(() => useAgentStore.getState().isEmptyIdleSession(), [])

  const handleNewSession = useCallback(() => {
    if (!workspace) return
    const store = useAgentStore.getState()
    // Already on an empty draft here, or on a saved session with nothing in
    // it yet: there is nothing new to start.
    if (!sessionId && !store.sessionId && !store.isAgentWorking) return
    if (isEmptyIdleSession()) return
    abortRef.current?.abort()
    abortRef.current = null
    // Eagerly delete the current session's draft before the store forgets
    // its id. The InputComposer's onValueChange('') fires asynchronously
    // after setValue(''), so by then the id is gone and the delete never
    // happens — leaving the old '/new' text to reappear on switch-back.
    const departingSessionId = store.sessionId
    if (departingSessionId) composerDrafts.delete(departingSessionId)
    inputRef.current?.setValue('')
    inputRef.current?.setFiles([])
    startNewSession({ navigate, workspace, current: { sessionId, workspace } })
  }, [inputRef, isEmptyIdleSession, navigate, sessionId, workspace])

  // Focus the chat input. Callable directly (shortcut / Command Palette)
  // or indirectly via `window.dispatchEvent(new CustomEvent('focus-chat-input'))`
  // — the latter decouples future callers (buttons elsewhere, other views)
  // from this component's ref.
  const handleDraftValueChange = useCallback((value: string) => {
    const key = useAgentStore.getState().sessionId ?? (!sessionId && workspace ? draftComposerKey(workspace) : null)
    if (!key) return
    if (value) {
      composerDrafts.set(key, { value })
      return
    }
    composerDrafts.delete(key)
  }, [sessionId, workspace])

  // A new-session draft keeps its unsent text per folder. Switching the
  // draft to another folder carries what is typed along; an empty composer
  // picks up that folder's saved text instead. When the first message
  // creates the session, text typed meanwhile moves to the session's key.
  const draftWorkspace = sessionId ? null : workspace
  const previousDraftWorkspaceRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousDraftWorkspaceRef.current
    previousDraftWorkspaceRef.current = draftWorkspace
    if (!draftWorkspace || previous === draftWorkspace) return
    const typed = previous ? composerDrafts.get(draftComposerKey(previous))?.value : undefined
    if (previous && typed) {
      composerDrafts.delete(draftComposerKey(previous))
      composerDrafts.set(draftComposerKey(draftWorkspace), { value: typed })
      return
    }
    inputRef.current?.setValue(composerDrafts.get(draftComposerKey(draftWorkspace))?.value ?? '')
  }, [draftWorkspace, inputRef])
  useEffect(() => {
    if (!draftWorkspace) return
    return useAgentStore.subscribe((state, prev) => {
      if (!state.sessionId || prev.sessionId) return
      const key = draftComposerKey(draftWorkspace)
      const pending = composerDrafts.get(key)
      composerDrafts.delete(key)
      if (pending?.value) composerDrafts.set(state.sessionId, pending)
    })
  }, [draftWorkspace])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [inputRef])

  useEffect(() => {
    const handler = () => focusInput()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [focusInput])

  useEffect(() => {
    if (isMobile || paletteOpen || !workspace || isSessionLoading) return

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length !== 1 || e.key.trim().length === 0) return
      if (isEditableTarget(e.target)) return
      // A dialog, overlay or lightbox is open: the letter is not for the chat.
      if (topBlockingLayer()) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.insertText(e.key)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isSessionLoading, isMobile, paletteOpen, workspace, inputRef])

  const handleAddFileComment = useCallback((path: string, startLine: number, endLine: number) => {
    const mention = startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`
    inputRef.current?.appendValue(`@${mention} `, { mentions: [mention] })
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
  //   - project workspace → ``"<ws>"``
  //   - chat with server-named session → ``"Chat: <title>"``
  //   - everything else → empty (tray shows ``No active session``)
  useEffect(() => {
    let label = ''
    const workspaceName = workspace ? workspaceLabel(workspace, chatWorkspace) : ''
    const identity = workspace ? workspaceName : sessionTitle ?? ''
    if (isAgentWorking) {
      label = identity ? `Working: ${identity}` : 'Working…'
    } else if (workspace) {
      // Chat's workspace name *is* "Chat", so "Chat: Chat" would be silly.
      label = isChatWorkspacePath(workspace, chatWorkspace)
        ? sessionTitle ? `Chat: ${sessionTitle}` : 'Chat'
        : workspaceName
    }
    void setTraySession(label)
  }, [workspace, sessionTitle, isAgentWorking, chatWorkspace])

  return {
    isEmptyIdleSession,
    handleNewSession,
    handleDraftValueChange,
    handleAddFileComment,
  }
}

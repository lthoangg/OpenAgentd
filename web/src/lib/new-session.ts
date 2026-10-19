/**
 * The one way into a new session.
 *
 * A new session is a lazy draft: ``/?workspace=<path>`` shows the
 * new-session screen and the composer, and nothing is saved until the first
 * message, whose ``POST /agent/chat`` (no session id) creates the session.
 * The layout then swaps the URL for ``/<session id>``. The sidebar's "+",
 * ⌘N, the palette, the desktop menu, ``/new`` and the empty route all come
 * through here, so an abandoned "New session" leaves no empty session
 * behind.
 */
import { useAgentStore } from '@/stores/useAgentStore'
import { saveLastWorkspace } from '@/utils/workspace'

export type NewSessionNavigate = (args: { to: '/'; search: { workspace: string }; replace?: boolean }) => unknown

export interface StartNewSessionOptions {
  navigate: NewSessionNavigate
  workspace: string
  /** What is on screen now, to skip a no-op restart of the same draft. */
  current?: { sessionId?: string | null; workspace?: string | null }
  /** Replace the history entry (redirects, switching a draft's folder). */
  replace?: boolean
}

/**
 * Open a draft for ``workspace``. Returns ``false`` when that empty draft is
 * already on screen (nothing to do), ``true`` once it navigated.
 */
export function startNewSession({ navigate, workspace, current, replace = false }: StartNewSessionOptions): boolean {
  const state = useAgentStore.getState()
  const onSameDraft = current !== undefined
    && !current.sessionId
    && current.workspace === workspace
    && !state.sessionId
    && !state.isAgentWorking
  if (onSameDraft) return false
  const { sessionModel, sessionThinkingLevel } = state
  // A full reset first: a draft whose first message is still in flight is
  // also session-less, and ``beginResolvedSession(null)`` alone would keep
  // that turn on the new screen.
  state.newSession()
  useAgentStore.getState().beginResolvedSession(null, {
    workspace,
    model: sessionModel,
    thinkingLevel: sessionThinkingLevel,
  })
  saveLastWorkspace(workspace)
  navigate({ to: '/', search: { workspace }, replace })
  return true
}

/** The key the composer's unsent text is kept under for a draft. */
export function draftComposerKey(workspace: string): string {
  return `draft:${workspace}`
}

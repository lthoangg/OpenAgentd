/**
 * Which previews the agent opened, and which of them a Preview tab already
 * shows.
 *
 * The agent's `preview` tool drives a page through the page's own script, and
 * that script only runs while the page is framed in the app. With the Preview
 * tab closed nothing frames it, so `PreviewKeepAlive` (app root) frames the
 * agent-opened pages out of sight. This store is its input:
 *
 * - `agent`: previews the agent opened, with when it last used them. They
 *   expire after `KEEP_ALIVE_TTL_MS` without use.
 * - `tabs`: previews a mounted `PreviewTabView` shows. A tab and a hidden
 *   frame must not both poll one listener, so a preview with a tab needs no
 *   hidden frame.
 *
 * A preview is the same one when its listener id matches (exact), or, before
 * either side knows the id, when its workspace and listener key match.
 */
import { create } from 'zustand'
import { type PreviewTarget, previewTargetKey } from '@/api/preview'

/** An agent-opened page nobody used for this long stops being kept alive. */
export const KEEP_ALIVE_TTL_MS = 15 * 60_000

export interface AgentPreview {
  /** `previewListenerKey`: what the backend keys the listener by. */
  key: string
  workspace: string
  target: PreviewTarget
  /** The listener id, once `openPreview` answered. */
  previewId?: string
  lastAgentUseAt: number
}

export interface ShownPreview {
  key: string
  previewId?: string
}

/**
 * One listener per workspace and target: a url per origin, and one for all
 * of a workspace's files (the same split the backend and the port memory use).
 */
export function previewListenerKey(workspace: string, target: PreviewTarget): string {
  return `${workspace}|${target.kind === 'file' ? 'files' : previewTargetKey(target)}`
}

interface PreviewKeepAliveState {
  agent: Record<string, AgentPreview>
  /** Mounted `PreviewTabView`s, by a per-instance token. */
  tabs: Record<string, ShownPreview>
  /** The agent opened `target`: keep it alive from now on. */
  registerAgent: (workspace: string, target: PreviewTarget, now?: number) => void
  /** The agent used a page of `workspace` (any action): refreshes its previews. */
  touchAgent: (workspace: string, now?: number) => void
  /** Learns the listener id of an agent-opened preview. */
  setAgentPreviewId: (key: string, previewId: string) => void
  /** Drops an agent-opened preview. */
  forgetKey: (key: string) => void
  /** Drops the agent-opened previews on a listener that was closed. */
  forgetPreviewId: (previewId: string) => void
  /** Drops the previews nobody used since `now - KEEP_ALIVE_TTL_MS`. */
  expire: (now?: number) => void
  /** A tab mounted (or retargeted) to show the preview under `key`. */
  showTab: (token: string, key: string, previewId?: string) => void
  hideTab: (token: string) => void
  reset: () => void
}

export const usePreviewKeepAliveStore = create<PreviewKeepAliveState>((set) => ({
  agent: {},
  tabs: {},
  registerAgent: (workspace, target, now = Date.now()) =>
    set((state) => {
      const key = previewListenerKey(workspace, target)
      const prev = state.agent[key]
      return { agent: { ...state.agent, [key]: { ...prev, key, workspace, target, lastAgentUseAt: now } } }
    }),
  touchAgent: (workspace, now = Date.now()) =>
    set((state) => {
      let changed = false
      const agent: Record<string, AgentPreview> = {}
      for (const [key, entry] of Object.entries(state.agent)) {
        if (entry.workspace === workspace) {
          agent[key] = { ...entry, lastAgentUseAt: now }
          changed = true
        } else agent[key] = entry
      }
      return changed ? { agent } : state
    }),
  setAgentPreviewId: (key, previewId) =>
    set((state) => {
      const entry = state.agent[key]
      if (!entry || entry.previewId === previewId) return state
      return { agent: { ...state.agent, [key]: { ...entry, previewId } } }
    }),
  forgetKey: (key) =>
    set((state) => {
      if (!(key in state.agent)) return state
      const { [key]: _gone, ...agent } = state.agent
      return { agent }
    }),
  forgetPreviewId: (previewId) =>
    set((state) => {
      const agent = Object.fromEntries(Object.entries(state.agent).filter(([, entry]) => entry.previewId !== previewId))
      return Object.keys(agent).length === Object.keys(state.agent).length ? state : { agent }
    }),
  expire: (now = Date.now()) =>
    set((state) => {
      const agent = Object.fromEntries(Object.entries(state.agent).filter(([, entry]) => now - entry.lastAgentUseAt < KEEP_ALIVE_TTL_MS))
      return Object.keys(agent).length === Object.keys(state.agent).length ? state : { agent }
    }),
  showTab: (token, key, previewId) =>
    set((state) => {
      const prev = state.tabs[token]
      if (prev && prev.key === key && prev.previewId === previewId) return state
      const tabs = { ...state.tabs, [token]: { key, previewId } }
      // The tab learned the listener id first: remember it for the agent's
      // entry, so closing the listener later can find it.
      const entry = state.agent[key]
      if (previewId && entry && !entry.previewId) {
        return { tabs, agent: { ...state.agent, [key]: { ...entry, previewId } } }
      }
      return { tabs }
    }),
  hideTab: (token) =>
    set((state) => {
      if (!(token in state.tabs)) return state
      const { [token]: _gone, ...tabs } = state.tabs
      return { tabs }
    }),
  reset: () => set({ agent: {}, tabs: {} }),
}))

/** True when a mounted Preview tab shows the same listener as `entry`. */
export function isShownInTab(tabs: Record<string, ShownPreview>, entry: Pick<AgentPreview, 'key' | 'previewId'>): boolean {
  for (const tab of Object.values(tabs)) {
    if (entry.previewId && tab.previewId) {
      if (entry.previewId === tab.previewId) return true
    } else if (tab.key === entry.key) return true
  }
  return false
}

/**
 * The island's data, as the desktop shell sends it (desktop/src-tauri/src/island.rs),
 * and the pure decisions about what to draw.
 */

/** `done` and `failed` are finished sessions not opened yet (unread). */
export type SessionState = 'running' | 'needs_input' | 'done' | 'failed'

export interface IslandSession {
  id: string
  title: string
  /** Folder name of the session's workspace. */
  workspace: string | null
  state: SessionState
  /** What the agent asked, while it waits on the user. */
  question: string | null
}

export interface IslandStatus {
  /** Bumped on every change. */
  seq: number
  /** Waiting-on-the-user sessions first. */
  sessions: IslandSession[]
  /** Finished sessions not opened yet, newest first. */
  unread: IslandSession[]
}

export interface NotchGeometry {
  hasNotch: boolean
  width: number
  height: number
}

/** Settings → General → Desktop (stored by the shell). */
export interface IslandSettings {
  enabled: boolean
  showWhenFrontmost: boolean
  showFinished: boolean
  expandOnHover: boolean
}

export const DEFAULT_ISLAND_SETTINGS: IslandSettings = {
  enabled: true,
  showWhenFrontmost: false,
  showFinished: true,
  expandOnHover: true,
}

export interface IslandView {
  status: IslandStatus
  geometry: NotchGeometry
  settings: IslandSettings
}

/** The pointer over the canvas, in CSS pixels, from the shell's polling. */
export interface IslandPointer {
  inside: boolean
  x: number
  y: number
}

export type IslandMode = 'hidden' | 'running' | 'needs_input' | 'done' | 'expanded'

/** Width of each side of the pill beside the notch. */
export const WING_WIDTH = 100
/** What the pill shrinks into on a screen without a notch. */
export const PLAIN_HIDDEN_WIDTH = 64
/** Width of the pill on a screen without a notch. */
export const PLAIN_WIDTH = 240
export const EXPANDED_WIDTH = 400
/** Concave corners where the pill meets the top of the screen (island.css --island-ear). */
export const EAR_WIDTH = 8
/** The canvas the pill lives in (CANVAS_* in island.rs). */
export const CANVAS_WIDTH = 460
export const CANVAS_HEIGHT = 380

export function islandMode(
  sessions: readonly IslandSession[],
  unread: readonly IslandSession[],
  hovered: boolean,
  settings: IslandSettings,
): IslandMode {
  if (sessions.length > 0 || unread.length > 0) {
    if (hovered && settings.expandOnHover) return 'expanded'
    if (sessions.some((s) => s.state === 'needs_input')) return 'needs_input'
    return sessions.length > 0 ? 'running' : 'done'
  }
  return 'hidden'
}

/** The pill's width. `hidden` is the size it shrinks into: the notch itself. */
export function islandWidth(mode: IslandMode, geometry: NotchGeometry): number {
  const { hasNotch, width } = geometry
  if (mode === 'hidden') return hasNotch ? width : PLAIN_HIDDEN_WIDTH
  const compact = hasNotch ? width + 2 * WING_WIDTH : Math.max(width, PLAIN_WIDTH)
  return mode === 'expanded' ? Math.min(Math.max(compact, EXPANDED_WIDTH), CANVAS_WIDTH - 2 * EAR_WIDTH) : compact
}

/** The pill's height: the notch's, or that plus the session list when expanded. */
export function islandHeight(mode: IslandMode, geometry: NotchGeometry, listHeight: number): number {
  if (mode !== 'expanded') return geometry.height
  return Math.min(geometry.height + listHeight, CANVAS_HEIGHT)
}

/** The two short labels either side of the notch: active work first. */
export function compactLabels(
  sessions: readonly IslandSession[],
  unread: readonly IslandSession[],
): { lead: string; detail: string } {
  const waiting = sessions.filter((s) => s.state === 'needs_input')
  if (waiting.length > 0) {
    return { lead: 'Needs input', detail: waiting.length === 1 ? waiting[0].title : `${waiting.length} sessions` }
  }
  if (sessions.length > 0) {
    return { lead: 'Working', detail: sessions.length === 1 ? sessions[0].title : `${sessions.length} sessions` }
  }
  if (unread.length > 0) {
    return {
      lead: allFailed(unread) ? 'Failed' : 'Done',
      detail: unread.length === 1 ? unread[0].title : `${unread.length} sessions`,
    }
  }
  return { lead: '', detail: '' }
}

/** Every unread session failed (the pill's mark turns to an alert). */
export function allFailed(unread: readonly IslandSession[]): boolean {
  return unread.length > 0 && unread.every((s) => s.state === 'failed')
}

/** The session a click on the pill itself opens. */
export function primarySessionId(sessions: readonly IslandSession[], unread: readonly IslandSession[]): string | null {
  return sessions[0]?.id ?? unread[0]?.id ?? null
}

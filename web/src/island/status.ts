/**
 * The island's data, as the desktop shell sends it (desktop/src-tauri/src/island.rs),
 * and the pure decisions about what to draw.
 */

/** `done` and `failed` are finished sessions not opened yet (unread). */
export type SessionState = 'running' | 'needs_input' | 'done' | 'failed'

/**
 * A session's goal: how far it has got while it works, and on a finished
 * row what became of it (as the turn's notification says).
 */
export type IslandGoal =
  | { status: 'active'; turn: number; maxTurns: number }
  | { status: 'achieved' | 'paused' | 'blocked' }

export interface IslandSession {
  id: string
  title: string
  /** Folder name of the session's workspace. */
  workspace: string | null
  state: SessionState
  /** What the agent asked, while it waits on the user. */
  question: string | null
  /** The server's name, when the sessions come from more than one server. */
  server?: string | null
  /** Absent from older shells. */
  goal?: IslandGoal | null
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

/**
 * The pill's one wing, left of the notch: the state mark and, for several
 * sessions, their count. Nothing grows right of the notch, where the status
 * icons start (macOS gives no way to read where they are), and the left wing
 * stays this narrow so the frontmost app's menus keep their room. Hover
 * expands it with the full details.
 */
export const WING_WIDTH = 44
/** What the pill shrinks into on a screen without a notch. */
export const PLAIN_HIDDEN_WIDTH = 40
/** Width of the pill on a screen without a notch: the mark and a count. */
export const PLAIN_WIDTH = 56
export const EXPANDED_WIDTH = 400
/** Concave corners where the pill meets the top of the screen (island.css --island-ear). */
export const EAR_WIDTH = 8
/** The canvas the pill lives in (CANVAS_* in island.rs). */
export const CANVAS_WIDTH = 460
export const CANVAS_HEIGHT = 380

/**
 * What the pill shows when it is not expanded. Attention first: a session
 * waiting on you, then finished work you have not read (even while others
 * still run), then running work.
 */
export function compactMode(
  sessions: readonly IslandSession[],
  unread: readonly IslandSession[],
): Exclude<IslandMode, 'expanded'> {
  if (sessions.some((s) => s.state === 'needs_input')) return 'needs_input'
  if (unread.length > 0) return 'done'
  return sessions.length > 0 ? 'running' : 'hidden'
}

export function islandMode(
  sessions: readonly IslandSession[],
  unread: readonly IslandSession[],
  hovered: boolean,
  settings: IslandSettings,
): IslandMode {
  const mode = compactMode(sessions, unread)
  return mode !== 'hidden' && hovered && settings.expandOnHover ? 'expanded' : mode
}

/** The pill's width. `hidden` is the size it shrinks into: the notch itself. */
export function islandWidth(mode: IslandMode, geometry: NotchGeometry): number {
  const { hasNotch, width } = geometry
  if (mode === 'hidden') return hasNotch ? width : PLAIN_HIDDEN_WIDTH
  if (mode === 'expanded') return Math.min(Math.max(width, EXPANDED_WIDTH), CANVAS_WIDTH - 2 * EAR_WIDTH)
  return hasNotch ? width + WING_WIDTH : PLAIN_WIDTH
}

/**
 * How far the pill's centre sits from the notch's (negative is left). The
 * compact pill's right edge is the notch's own, so its wing only grows left;
 * expanded, it is centred.
 */
export function islandShift(mode: IslandMode, geometry: NotchGeometry): number {
  return geometry.hasNotch && mode !== 'hidden' && mode !== 'expanded' ? -WING_WIDTH / 2 : 0
}

/**
 * The pill's click and hover area for the shell: the pill and its corners,
 * less the right corner while the compact pill ends at the notch (it is
 * hidden there, so the status icon beside the notch keeps its clicks).
 */
export function islandHitBox(mode: IslandMode, geometry: NotchGeometry, width: number): { width: number; shift: number } {
  const shift = islandShift(mode, geometry)
  if (shift === 0) return { width: width + 2 * EAR_WIDTH, shift }
  return { width: width + EAR_WIDTH, shift: shift - EAR_WIDTH / 2 }
}

/** The number behind the compact pill's mark, in {@link compactMode}'s order. */
export function compactCount(sessions: readonly IslandSession[], unread: readonly IslandSession[]): number {
  const waiting = sessions.filter((s) => s.state === 'needs_input').length
  if (waiting > 0) return waiting
  return unread.length > 0 ? unread.length : sessions.length
}

/** The pill's height: the notch's, or that plus the session list when expanded. */
export function islandHeight(mode: IslandMode, geometry: NotchGeometry, listHeight: number): number {
  if (mode !== 'expanded') return geometry.height
  return Math.min(geometry.height + listHeight, CANVAS_HEIGHT)
}

const GOAL_OUTCOMES: Record<Exclude<IslandGoal['status'], 'active'>, string> = {
  achieved: 'Goal achieved',
  paused: 'Goal paused',
  blocked: 'Goal blocked',
}

/** "Goal 7/50" while the goal works, else the notification's words for what became of it. */
export function goalLabel(session: IslandSession): string | null {
  const goal = session.goal
  if (!goal) return null
  return goal.status === 'active' ? `Goal ${goal.turn}/${goal.maxTurns}` : GOAL_OUTCOMES[goal.status]
}

/** The two short labels either side of the notch, in {@link compactMode}'s order. */
export function compactLabels(
  sessions: readonly IslandSession[],
  unread: readonly IslandSession[],
): { lead: string; detail: string } {
  const waiting = sessions.filter((s) => s.state === 'needs_input')
  if (waiting.length > 0) {
    return { lead: 'Needs input', detail: waiting.length === 1 ? waiting[0].title : `${waiting.length} sessions` }
  }
  if (unread.length > 0) {
    return {
      lead: (unread.length === 1 && goalLabel(unread[0])) || (allFailed(unread) ? 'Failed' : 'Done'),
      detail: unread.length === 1 ? unread[0].title : `${unread.length} sessions`,
    }
  }
  if (sessions.length > 0) {
    if (sessions.length === 1) return { lead: goalLabel(sessions[0]) ?? 'Working', detail: sessions[0].title }
    return { lead: 'Working', detail: `${sessions.length} sessions` }
  }
  return { lead: '', detail: '' }
}

/** Every unread session failed (the pill's mark turns to an alert). */
export function allFailed(unread: readonly IslandSession[]): boolean {
  return unread.length > 0 && unread.every((s) => s.state === 'failed')
}

/** The session a click on the pill itself opens: the one its labels name first. */
export function primarySessionId(sessions: readonly IslandSession[], unread: readonly IslandSession[]): string | null {
  const waiting = sessions.find((s) => s.state === 'needs_input')
  return waiting?.id ?? unread[0]?.id ?? sessions[0]?.id ?? null
}

/** The expanded list: waiting sessions, then unread finished ones, then running ones. */
export function listOrder(sessions: readonly IslandSession[], unread: readonly IslandSession[]): IslandSession[] {
  const waiting = sessions.filter((s) => s.state === 'needs_input')
  const running = sessions.filter((s) => s.state !== 'needs_input')
  return [...waiting, ...unread, ...running]
}

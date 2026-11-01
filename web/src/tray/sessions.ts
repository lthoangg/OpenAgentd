/**
 * The sessions the tray lists above the provider limits, as the desktop
 * shell sends them (`tray_sessions`, desktop/src-tauri/src/tray_popup.rs):
 * the same feed the notch and the pet read.
 */
import { type IslandSession, type UnreachableServer, goalLabel } from '@/island/status'

export type TraySession = IslandSession

export interface TraySessions {
  /** The app is on a server (a window's, or the builtin while it runs). */
  connected: boolean
  /** Waiting on the user, every server merged. */
  needsYou: TraySession[]
  running: TraySession[]
  /** Followed servers that dropped off. */
  unreachable: UnreachableServer[]
}

/** Rows shown per group; the rest are one click away in the app. */
export const MAX_ROWS = 6

/** The sessions payload, or null when the shell sent something else. */
export function parseSessions(value: unknown): TraySessions | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<TraySessions>
  if (!Array.isArray(v.needsYou) || !Array.isArray(v.running)) return null
  return {
    connected: v.connected !== false,
    needsYou: v.needsYou,
    running: v.running,
    unreachable: Array.isArray(v.unreachable) ? v.unreachable : [],
  }
}

/** The line under a row's title: server, workspace or goal, the pinned account, and what a waiting session asked. */
export function rowSubtitle(session: TraySession): string {
  const pinned = session.account ? `Pinned to ${session.account}` : ''
  const meta = [session.server, goalLabel(session) ?? session.workspace, pinned].filter(Boolean).join(' · ')
  const question = session.state === 'needs_input' ? session.question?.trim() : ''
  return [meta, question ? `“${question}”` : ''].filter(Boolean).join(' · ')
}

/** "1 needs you" / "3 need you". */
export function needsYouText(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`
}

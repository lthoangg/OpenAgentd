/**
 * Home-screen widget snapshot (iOS WidgetKit, Android AppWidget).
 *
 * A widget cannot hold a connection, so the app saves what it last knew:
 * the sessions waiting on you or working, the last session, and the next
 * scheduled task. The native side stores it where the widget can read it.
 * It never carries the server address or access key.
 */
import type { InfiniteData } from '@tanstack/react-query'
import type { ScheduledTaskResponse, SessionPageResponse, SessionResponse } from '@/api/types'
import { sessionWorking } from '@/lib/active-sessions'
import { pathBasename } from '@/utils/workspace'

/** Rows the medium inbox widget shows. */
export const WIDGET_INBOX_LIMIT = 3

export type WidgetSessionState = 'needs_input' | 'running' | 'idle'

export interface WidgetSession {
  id: string
  title: string
  /** Folder name, not the path. */
  workspace: string | null
  state: WidgetSessionState
  lastMessageAt: string | null
}

export interface WidgetTask {
  id: string
  name: string
  nextFireAt: string
  lastRunAt: string | null
  /** Whether the last run succeeded; null before the first run. */
  lastRunOk: boolean | null
}

export interface WidgetSnapshot {
  /** When the app last knew this; widgets show "as of". */
  updatedAt: string
  lastSession: WidgetSession | null
  inbox: WidgetSession[]
  nextTask: WidgetTask | null
}

type SessionPages = InfiniteData<SessionPageResponse> | undefined

function topLevel(data: SessionPages): SessionResponse[] {
  return (data?.pages.flatMap((page) => page.data) ?? []).filter(
    (session) => !session.parent_session_id && Boolean(session.workspace),
  )
}

function activityTime(session: SessionResponse): string | null {
  return session.last_message_at ?? session.updated_at ?? session.created_at
}

function byActivity(a: SessionResponse, b: SessionResponse): number {
  return Date.parse(activityTime(b) ?? '') - Date.parse(activityTime(a) ?? '') || 0
}

function sessionState(session: SessionResponse): WidgetSessionState {
  if (session.needs_input === true) return 'needs_input'
  if (sessionWorking(session) || session.background_work === true) return 'running'
  return 'idle'
}

function toWidgetSession(session: SessionResponse): WidgetSession {
  return {
    id: session.id,
    title: session.title?.trim() || 'Untitled session',
    workspace: session.workspace ? pathBasename(session.workspace) : null,
    state: sessionState(session),
    lastMessageAt: activityTime(session),
  }
}

const STATE_RANK: Record<WidgetSessionState, number> = { needs_input: 0, running: 1, idle: 2 }

function nextTask(tasks: readonly ScheduledTaskResponse[]): WidgetTask | null {
  const upcoming = tasks
    .filter((task) => task.enabled && task.next_fire_at)
    .sort((a, b) => Date.parse(a.next_fire_at ?? '') - Date.parse(b.next_fire_at ?? ''))[0]
  if (!upcoming?.next_fire_at) return null
  return {
    id: upcoming.id,
    name: upcoming.name,
    nextFireAt: upcoming.next_fire_at,
    lastRunAt: upcoming.last_run_at,
    lastRunOk: upcoming.last_run_at ? !upcoming.last_error : null,
  }
}

/**
 * The inbox puts sessions that need you first, then working ones, then the
 * most recent, each group newest first. ``active`` is the running/waiting
 * list, ``recent`` the activity-sorted list.
 */
export function buildWidgetSnapshot({ active, recent, tasks, now }: {
  active: SessionPages
  recent: SessionPages
  tasks: readonly ScheduledTaskResponse[] | undefined
  now: Date
}): WidgetSnapshot {
  const recentSessions = topLevel(recent).sort(byActivity)
  const seen = new Map<string, SessionResponse>()
  // An active row is fresher than the same session on a recent page.
  for (const session of [...topLevel(active), ...recentSessions]) {
    if (!seen.has(session.id)) seen.set(session.id, session)
  }
  const inbox = [...seen.values()]
    .map((session) => ({ session, widget: toWidgetSession(session) }))
    .sort((a, b) => STATE_RANK[a.widget.state] - STATE_RANK[b.widget.state] || byActivity(a.session, b.session))
    .slice(0, WIDGET_INBOX_LIMIT)
    .map(({ widget }) => widget)
  const last = recentSessions[0] ? seen.get(recentSessions[0].id) : undefined
  return {
    updatedAt: now.toISOString(),
    lastSession: last ? toWidgetSession(last) : null,
    inbox,
    nextTask: nextTask(tasks ?? []),
  }
}

/** Hand the snapshot to the native shell. Best effort: a widget is never worth an error. */
export async function pushWidgetSnapshot(snapshot: WidgetSnapshot): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('widget_update_snapshot', { snapshot })
  } catch {
    // An older shell without the command, or no widget storage: nothing to do.
  }
}

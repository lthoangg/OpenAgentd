/**
 * Home-screen widget snapshot (iOS WidgetKit, Android AppWidget).
 *
 * A widget cannot hold a connection, so the app saves what it last knew:
 * the sessions waiting on you or working, the last session, and the next
 * scheduled task. The native side stores it where the widget can read it.
 * It never carries the server address or access key: the server the
 * sessions are on is named by an opaque token (`server-refs.ts`) that only
 * this app can map back, so a tap on a session opens it on that server.
 */
import type { InfiniteData } from '@tanstack/react-query'
import type { ScheduledTaskResponse, SessionPageResponse, SessionResponse } from '@/api/types'
import { sessionWorking } from '@/lib/active-sessions'
import type { ServerRef } from '@/lib/server-refs'
import { getChatWorkspaceEntry, workspaceLabel } from '@/utils/workspace'

/** Rows the medium inbox widget shows. */
export const WIDGET_INBOX_LIMIT = 3

export type WidgetSessionState = 'needs_input' | 'running' | 'idle'

export interface WidgetSession {
  id: string
  title: string
  /** Folder name, not the path; "Chat" for the Chat workspace. */
  workspace: string | null
  state: WidgetSessionState
  lastMessageAt: string | null
}

export interface WidgetTask {
  id: string
  name: string
  nextFireAt: string
  /** Whether the last run succeeded; null before the first run. */
  lastRunOk: boolean | null
}

export interface WidgetSnapshot {
  /** When the app last knew this; widgets show "as of". */
  updatedAt: string
  lastSession: WidgetSession | null
  inbox: WidgetSession[]
  nextTask: WidgetTask | null
  /** Token for the server these sessions are on; added when pushed. */
  server?: string | null
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

type ChatWorkspace = { path: string; name: string } | null

function toWidgetSession(session: SessionResponse, chat: ChatWorkspace): WidgetSession {
  return {
    id: session.id,
    title: session.title?.trim() || 'Untitled session',
    workspace: session.workspace ? workspaceLabel(session.workspace, chat) : null,
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
    lastRunOk: upcoming.last_run_at ? !upcoming.last_error : null,
  }
}

/**
 * The inbox puts sessions that need you first, then working ones, then the
 * most recent, each group newest first. ``active`` is the running/waiting
 * list, ``recent`` the activity-sorted list, ``chat`` the Chat workspace
 * (its folder is the home directory, so its sessions are named by it).
 */
export function buildWidgetSnapshot({ active, recent, tasks, now, chat = getChatWorkspaceEntry() }: {
  active: SessionPages
  recent: SessionPages
  tasks: readonly ScheduledTaskResponse[] | undefined
  now: Date
  chat?: ChatWorkspace
}): WidgetSnapshot {
  const recentSessions = topLevel(recent).sort(byActivity)
  const seen = new Map<string, SessionResponse>()
  // An active row is fresher than the same session on a recent page.
  for (const session of [...topLevel(active), ...recentSessions]) {
    if (!seen.has(session.id)) seen.set(session.id, session)
  }
  const inbox = [...seen.values()]
    .map((session) => ({ session, widget: toWidgetSession(session, chat) }))
    .sort((a, b) => STATE_RANK[a.widget.state] - STATE_RANK[b.widget.state] || byActivity(a.session, b.session))
    .slice(0, WIDGET_INBOX_LIMIT)
    .map(({ widget }) => widget)
  const last = recentSessions[0] ? seen.get(recentSessions[0].id) : undefined
  return {
    updatedAt: now.toISOString(),
    lastSession: last ? toWidgetSession(last, chat) : null,
    inbox,
    nextTask: nextTask(tasks ?? []),
  }
}

/**
 * The server whose sessions the widgets show now, kept where it outlives
 * the page: the app may be on another server (or none) by the time that
 * one is removed.
 */
const WIDGET_SERVER_KEY = 'oa-widget-server'

function rememberWidgetServer(ref: ServerRef | null): void {
  try {
    if (ref && (ref.baseUrl || ref.deviceId)) window.localStorage.setItem(WIDGET_SERVER_KEY, JSON.stringify(ref))
    else window.localStorage.removeItem(WIDGET_SERVER_KEY)
  } catch {
    // Storage blocked: a removed server's rows stay until the next sync.
  }
}

function widgetServer(): ServerRef | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(WIDGET_SERVER_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const { baseUrl, deviceId } = parsed as Record<string, unknown>
    return {
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
      ...(typeof deviceId === 'string' ? { deviceId } : {}),
    }
  } catch {
    return null
  }
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  const clean = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
  return a !== undefined && b !== undefined && clean(a) === clean(b)
}

/**
 * Hand the snapshot to the native shell; false when it did not get there.
 * Best effort: a widget is never worth an error.
 */
export async function pushWidgetSnapshot(snapshot: WidgetSnapshot): Promise<boolean> {
  try {
    // Loaded here, not at startup: only the phone writes widget snapshots.
    const [{ currentServerRef }, { serverToken }] = await Promise.all([
      import('@/lib/notification-taps'),
      import('@/lib/server-refs'),
    ])
    const ref = await currentServerRef()
    const server = serverToken(ref)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('widget_update_snapshot', { snapshot: server ? { ...snapshot, server } : snapshot })
    rememberWidgetServer(server ? ref : null)
    return true
  } catch {
    // An older shell without the command, or no widget storage: nothing to do.
    return false
  }
}

/**
 * The app let go of a server: a saved one was removed (`baseUrl`), or the
 * account signed out (`account`, which takes every computer of it). If the
 * widgets show that server's sessions, empty them: their rows would open
 * nothing. A saved server stays through a sign-out, and the other way round.
 */
export async function forgetWidgetServer(gone: { baseUrl?: string; account?: boolean }): Promise<void> {
  const shown = widgetServer()
  if (!shown) return
  const isGone = shown.deviceId ? gone.account === true : sameAddress(shown.baseUrl, gone.baseUrl)
  if (!isGone) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('widget_update_snapshot', {
      snapshot: { updatedAt: new Date().toISOString(), lastSession: null, inbox: [], nextTask: null } satisfies WidgetSnapshot,
    })
    rememberWidgetServer(null)
  } catch {
    // An older shell, or no widget storage: the rows stay until the next sync.
  }
}

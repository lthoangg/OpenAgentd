/**
 * Review dock tab model.
 *
 * The dock is an editor-style strip of file previews, full-height diffs,
 * commit views, web previews, and terminals. It starts empty, on a launcher.
 * Git, the agent task list, the scheduler, the session plan, and `/btw` side
 * questions are singleton tabs opened on demand: Git from the status-bar
 * branch or ⌘⇧G, Tasks with ⌘T, Schedule from its command, the plan from the
 * Tasks view, a plan review, or the transcript, side questions from `/btw`.
 * Tab ids are stable per target so re-opening a file, diff, or commit
 * focuses the existing tab instead of stacking duplicates.
 */
import type { GitCommit, WorkspaceFileInfo } from '@/api/types'
import { type PreviewTarget, previewTargetKey } from '@/api/preview'
import { type ChangedFileStatus, safeDecodeURIComponent } from './diff-helpers'

export const REVIEW_TAB_ID = 'review'
export const TASKS_TAB_ID = 'tasks'
export const SCHEDULE_TAB_ID = 'schedule'
export const PLAN_TAB_ID = 'plan'
export const BTW_TAB_ID = 'btw'

export type DockTab =
  | { id: typeof REVIEW_TAB_ID; type: 'review'; title: 'Git' }
  | { id: typeof TASKS_TAB_ID; type: 'tasks'; title: 'Tasks' }
  | { id: typeof SCHEDULE_TAB_ID; type: 'schedule'; title: 'Schedule' }
  | { id: typeof PLAN_TAB_ID; type: 'plan'; title: 'Plan' }
  | { id: typeof BTW_TAB_ID; type: 'btw'; title: 'BTW' }
  | { id: string; type: 'file'; title: string; file: WorkspaceFileInfo }
  | { id: string; type: 'diff'; title: string; path: string; status: ChangedFileStatus }
  | { id: string; type: 'commit'; title: string; commit: GitCommit }
  /**
   * A web preview. One tab per dev-server origin or workspace file; ``navKey``
   * grows each time the tab is asked to show ``target`` again, so a new
   * path for the same origin navigates the open tab.
   */
  | { id: string; type: 'preview'; title: string; target: PreviewTarget; navKey: number }
  | { id: string; type: 'terminal'; title: string; termId: string }

export type DockTabOf<T extends DockTab['type']> = Extract<DockTab, { type: T }>

/** Singleton view tabs the shell can ask the dock to open (Git / Tasks / Scheduled Tasks / Plan / BTW). */
export type DockView = 'review' | 'tasks' | 'schedule' | 'plan' | 'btw'

/**
 * A file tab's info at render time. Tabs keep the listing entry they opened
 * with, which goes stale when the agent or a discard changes the file; prefer
 * the current entry for the same path, and mark the file deleted once the
 * working diff says so. A path merely missing from the listing is not treated
 * as deleted: the listing skips noise directories and oversized ignored ones,
 * whose files can still be previewed.
 */
export function resolveFileTabInfo(
  snapshot: WorkspaceFileInfo,
  listed: WorkspaceFileInfo | undefined,
  workingStatus: ChangedFileStatus | undefined,
): WorkspaceFileInfo {
  if (listed) return listed
  if (workingStatus === 'D') return { ...snapshot, size: 0, deleted: true }
  return snapshot
}

export interface DockViewRequest {
  view: DockView
  /** Monotonic; the dock handles each key once. */
  key: number
}

export interface DiffTabRequest {
  path: string
  status?: ChangedFileStatus
  /** Monotonic; the dock handles each key once. */
  key: number
}

export interface PreviewTabRequest {
  target: PreviewTarget
  /** Monotonic; the dock handles each key once. */
  key: number
  /** Show the tab without sending an already open one to ``target``. */
  focusOnly?: boolean
}

export const REVIEW_TAB: DockTabOf<'review'> = { id: REVIEW_TAB_ID, type: 'review', title: 'Git' }
export const TASKS_TAB: DockTabOf<'tasks'> = { id: TASKS_TAB_ID, type: 'tasks', title: 'Tasks' }
export const SCHEDULE_TAB: DockTabOf<'schedule'> = { id: SCHEDULE_TAB_ID, type: 'schedule', title: 'Schedule' }
export const PLAN_TAB: DockTabOf<'plan'> = { id: PLAN_TAB_ID, type: 'plan', title: 'Plan' }
export const BTW_TAB: DockTabOf<'btw'> = { id: BTW_TAB_ID, type: 'btw', title: 'BTW' }

const VIEW_TABS: Record<DockView, DockTab> = { review: REVIEW_TAB, tasks: TASKS_TAB, schedule: SCHEDULE_TAB, plan: PLAN_TAB, btw: BTW_TAB }

/** The singleton tab a view request opens. */
export function viewTab(view: DockView): DockTab {
  return VIEW_TABS[view]
}

/** Tabs whose title is a plain label rather than a path or sha. */
export function isViewTab(tab: DockTab): tab is DockTabOf<DockView> {
  return Object.hasOwn(VIEW_TABS, tab.type)
}

export const fileTabId = (path: string) => `file:${path}`
export const diffTabId = (path: string) => `diff:${path}`
export const commitTabId = (sha: string) => `commit:${sha}`
export const terminalTabId = (termId: string) => `terminal:${termId}`
export const previewTabId = (target: PreviewTarget) => `preview:${previewTargetKey(target)}`

/** Tab title: the dev server's host:port, or the file's name. */
export function previewTabTitle(target: PreviewTarget): string {
  if (target.kind === 'file') return basename(target.path)
  try {
    return new URL(target.url.includes('://') ? target.url : `http://${target.url}`).host
  } catch {
    return target.url
  }
}

const TERMINAL_PREFIX = 'terminal:'

/** Terminal session id encoded in a tab id, or ``null`` for other tabs. */
export function terminalIdFromTabId(tabId: string): string | null {
  return tabId.startsWith(TERMINAL_PREFIX) ? tabId.slice(TERMINAL_PREFIX.length) : null
}

export function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * Accessible name for a tab. File and diff tabs for the same path share a
 * visible title, so the diff tab's name says what it is.
 */
export function dockTabLabel(tab: DockTab): string {
  switch (tab.type) {
    case 'diff':
      return `${tab.title} diff`
    case 'commit':
      return `Commit ${tab.commit.short_sha}`
    case 'schedule':
      return 'Scheduled tasks'
    case 'plan':
      return 'Session plan'
    case 'btw':
      return 'BTW side questions'
    case 'preview':
      return `Preview ${tab.title}`
    default:
      return tab.title
  }
}

/** Hover text: the full path or subject the truncated tab title stands for. */
export function dockTabTooltip(tab: DockTab): string | null {
  switch (tab.type) {
    case 'file':
      return tab.file.path
    case 'diff':
      return `${tab.path} (working tree diff)`
    case 'commit':
      return safeDecodeURIComponent(tab.commit.subject)
    case 'preview':
      return tab.target.kind === 'file' ? `${tab.target.path} (preview)` : `${tab.target.url} (preview)`
    default:
      return null
  }
}

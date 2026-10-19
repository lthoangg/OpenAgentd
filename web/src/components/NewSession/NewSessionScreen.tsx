/**
 * NewSessionScreen — the new-session draft (`/?workspace=<path>`).
 *
 * Nothing is saved until the first message: this screen names the folder
 * the session will run in (a chip that switches it), hosts the composer on
 * desktop when it is centered, and offers the way back to earlier work —
 * recent folders and this folder's recent sessions. No starter prompts:
 * the composer is the call to action.
 */
import { useMemo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { Folder, FolderPlus, GitBranch, MessageCircle } from 'lucide-react'
import { getCodingWorkspaceStatus, getCodingWorkspaceTree } from '@/api/client'
import type { CodingWorkspaceTreeChat, CodingWorkspaceTreeRepository, SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'
import { useAllSessionsQuery, useWorkspaceSessionsQuery } from '@/queries/useSessionsQuery'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { pathBasename, sameWorkspacePath } from '@/utils/workspace'
import { RecentSessionsList } from '../WorkspaceInfoCard'
import { WorkspacePicker } from './WorkspacePicker'

const RECENT_FOLDERS = 5
const RECENT_SESSIONS = 5
const NO_REPOSITORIES: CodingWorkspaceTreeRepository[] = []

/** Where the composer is on this screen. */
export type NewSessionComposerSlot = 'inline' | 'floating' | 'docked'

/**
 * Phones always dock the full composer at the bottom (no collapsed bar);
 * desktop and tablet follow the "New session composer" setting.
 */
export function newSessionComposerSlot(isMobile: boolean, preference: 'centered' | 'floating'): NewSessionComposerSlot {
  if (isMobile) return 'docked'
  return preference === 'centered' ? 'inline' : 'floating'
}

/**
 * Up to ``limit`` folders to switch to: the workspaces of the most recently
 * active sessions first, then the sidebar's order. Leaves out ``current`` and
 * Chat (which has a chip of its own).
 */
export function recentFolders(
  sessions: readonly SessionResponse[],
  repositories: readonly CodingWorkspaceTreeRepository[],
  current: string,
  chatPath: string | null,
  limit = RECENT_FOLDERS,
): string[] {
  const out: string[] = []
  const add = (path: string | null | undefined) => {
    if (!path || out.length >= limit) return
    if (sameWorkspacePath(path, current) || sameWorkspacePath(path, chatPath)) return
    if (out.some((seen) => sameWorkspacePath(seen, path))) return
    out.push(path)
  }
  for (const session of sessions) add(session.workspace)
  for (const repo of repositories) add(repo.path)
  return out
}

function FolderChip({ icon, label, mono = true, onClick, title }: { icon: ReactNode; label: string; mono?: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-6 max-w-48 items-center gap-1.5 rounded-full border border-(--color-border) px-2 text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-3"
    >
      {icon}
      <span className={`min-w-0 truncate text-[11px] ${mono ? 'font-mono' : ''}`}>{label}</span>
    </button>
  )
}

export function NewSessionScreen({
  workspace,
  workspaceName,
  isChat,
  chatWorkspace,
  composer = null,
  composerSlot,
  isMobile,
  onSelectWorkspace,
  onOpenFolder,
}: {
  workspace: string
  workspaceName: string
  isChat: boolean
  chatWorkspace: CodingWorkspaceTreeChat | null
  /** The composer, when it sits in this screen (centered, desktop). */
  composer?: ReactNode
  composerSlot: NewSessionComposerSlot
  isMobile: boolean
  /** Switch the draft to another folder. */
  onSelectWorkspace: (path: string) => void
  onOpenFolder: () => void
}) {
  const reducedMotion = useReducedMotion()
  const { os } = usePlatform()
  const { data: tree } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: 30_000,
  })
  const repositories = tree?.repositories ?? NO_REPOSITORIES
  // Same key and options as the status bar's git chip: no extra request.
  const { data: status } = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    enabled: !isChat,
    staleTime: 10_000,
  })
  const branch = !isChat && status?.is_git_repo ? status.branch : null
  const everywhere = useAllSessionsQuery('activity')
  const { data: here } = useWorkspaceSessionsQuery(workspace, true, { sort: 'activity' })

  const folders = useMemo(
    () => recentFolders(everywhere.data?.pages.flatMap((page) => page.data) ?? [], repositories, workspace, chatWorkspace?.path ?? null),
    [everywhere.data, repositories, workspace, chatWorkspace],
  )
  const folderLabel = (path: string) => {
    for (const repo of repositories) {
      if (sameWorkspacePath(repo.path, path)) return repo.name
      const worktree = repo.worktrees.find((item) => sameWorkspacePath(item.path, path))
      if (worktree) return worktree.name
    }
    return pathBasename(path)
  }
  const recentSessions = (here?.pages.flatMap((page) => page.data) ?? [])
    .filter((session) => !session.parent_session_id)
    .slice(0, RECENT_SESSIONS)

  const hints = [
    ['/', 'commands'],
    ['@', 'files'],
    [shortcutLabel(APP_SHORTCUTS.commandPalette, os), 'palette'],
    [shortcutLabel(APP_SHORTCUTS.newSession, os), 'new session'],
  ] as const

  return (
    <motion.div
      data-testid="new-session-screen"
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {/* Desktop: the hero sits a little above center (the spacer above is
          the shorter one) so the composer lands near the optical middle. */}
      <div className={`mx-auto flex w-full max-w-3xl flex-col px-4 ${isMobile ? 'pt-6 pb-4' : 'flex-1 pb-28'}`}>
        {!isMobile && <div className="min-h-8 flex-[38]" aria-hidden="true" />}
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className={`font-semibold text-(--color-text) ${isMobile ? 'self-start text-left text-base' : 'text-base md:text-lg'}`}>
            {isChat ? 'Ask anything' : (
              <>What should we build in <span className="font-mono">{workspaceName}</span>?</>
            )}
          </h1>
          <div className={`flex max-w-full flex-wrap items-center gap-2 ${isMobile ? 'self-start' : 'justify-center'}`}>
            <WorkspacePicker
              workspace={workspace}
              label={workspaceName}
              isChat={isChat}
              chat={chatWorkspace}
              repositories={repositories}
              onSelect={onSelectWorkspace}
              onOpenFolder={onOpenFolder}
            />
            {branch && (
              <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-(--color-text-subtle)">
                <GitBranch size={11} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />
                <span className="truncate">{branch}</span>
              </span>
            )}
          </div>
          {composerSlot === 'inline' && composer && <div className="mt-2 w-full">{composer}</div>}
          {composerSlot === 'floating' && (
            <p className="text-xs text-(--color-text-muted)">
              Start typing, or click the bar below. <kbd className="ml-1 rounded-xs border border-(--color-border) bg-(--bg-key) px-1 font-mono text-[11px]">esc</kbd> tucks it away.
            </p>
          )}
          {!isMobile && (
            <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-(--color-text-subtle)" aria-label="Shortcuts">
              {hints.map(([key, label], index) => (
                <span key={label} className="inline-flex items-center gap-1">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  <kbd className="font-mono text-(--color-text-muted)">{key}</kbd>
                  {label}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className={`mx-auto mt-8 flex w-full flex-col gap-6 ${isMobile ? 'mt-6' : 'max-w-[640px]'}`}>
          <section aria-label="Recent folders">
            <h2 className="mb-1.5 px-1.5 label-caps text-(--color-text-subtle)">Recent folders</h2>
            <div className="flex flex-wrap gap-1.5 px-1.5">
              {folders.map((path) => (
                <FolderChip
                  key={path}
                  icon={<Folder size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />}
                  label={folderLabel(path)}
                  title={path}
                  onClick={() => onSelectWorkspace(path)}
                />
              ))}
              {chatWorkspace && !isChat && (
                <FolderChip
                  icon={<MessageCircle size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />}
                  label={chatWorkspace.name}
                  mono={false}
                  onClick={() => onSelectWorkspace(chatWorkspace.path)}
                />
              )}
              <FolderChip
                icon={<FolderPlus size={11} className="shrink-0" aria-hidden="true" />}
                label="Open folder…"
                mono={false}
                onClick={onOpenFolder}
              />
            </div>
          </section>
          {recentSessions.length > 0 && (
            <RecentSessionsList
              sessions={recentSessions}
              workspace={workspace}
              label={isMobile ? 'Recent sessions' : `Recent sessions in ${workspaceName}`}
              headingLevel={2}
            />
          )}
        </div>
        {!isMobile && <div className="min-h-8 flex-[62]" aria-hidden="true" />}
      </div>
    </motion.div>
  )
}

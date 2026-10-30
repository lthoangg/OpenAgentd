/**
 * NewSessionScreen — the new-session draft (`/?workspace=<path>`).
 *
 * Nothing is saved until the first message: this screen names the folder
 * the session will run in (a chip that switches it), hosts the composer on
 * desktop (phones dock it at the bottom), and offers the way back to earlier work:
 * this folder's three latest sessions, under Continue. Other folders are one
 * click away in the folder picker, so there is no second folder list. No
 * starter prompts: the composer is the call to action.
 *
 * ``setup``: until a message could run (no model, or its provider is not
 * connected), the model setup card sits above the composer.
 *
 * ``leaving``: the first message was just sent. AgentChatView renders an
 * inert copy over the incoming chat that fades away while the composer
 * glides to the bottom; ``composerPlaceholderHeight`` holds the composer's
 * place so the copy does not reflow as it fades.
 */
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import { useQuery } from '@tanstack/react-query'
import { GitBranch } from 'lucide-react'
import { getCodingWorkspaceStatus, getCodingWorkspaceTree } from '@/api/client'
import type { CodingWorkspaceTreeChat, CodingWorkspaceTreeRepository } from '@/api/types'
import { queryKeys } from '@/queries/keys'
import { useWorkspaceSessionsQuery } from '@/queries/useSessionsQuery'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { RecentSessionsList } from '../WorkspaceInfoCard'
import { WorkspacePicker } from './WorkspacePicker'

const RECENT_SESSIONS = 3
const NO_REPOSITORIES: CodingWorkspaceTreeRepository[] = []

export function NewSessionScreen({
  workspace,
  workspaceName,
  isChat,
  chatWorkspace,
  composer = null,
  setup = null,
  isMobile,
  leaving = false,
  composerPlaceholderHeight,
  onSelectWorkspace,
  onOpenFolder,
}: {
  workspace: string
  workspaceName: string
  isChat: boolean
  chatWorkspace: CodingWorkspaceTreeChat | null
  /** The composer, when it sits in this screen (desktop). */
  composer?: ReactNode
  /** The model setup card, while no message could run. */
  setup?: ReactNode
  isMobile: boolean
  /** Fade out as an inert copy (the hand-off into the chat). */
  leaving?: boolean
  /** While leaving: the height the composer had, kept as empty space. */
  composerPlaceholderHeight?: number
  /** Switch the draft to another folder. */
  onSelectWorkspace: (path: string) => void
  onOpenFolder: () => void
}) {
  const reducedMotion = useReducedMotion()
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
  const { data: here } = useWorkspaceSessionsQuery(workspace)

  const recentSessions = (here?.pages.flatMap((page) => page.data) ?? [])
    .filter((session) => !session.parent_session_id)
    .slice(0, RECENT_SESSIONS)

  return (
    <motion.div
      data-testid={leaving ? 'new-session-screen-leaving' : 'new-session-screen'}
      // Leaving starts from fully shown: ``initial={false}`` would start it
      // at the ``animate`` target and skip the fade.
      initial={leaving ? { opacity: 1, y: 0 } : reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={leaving ? { opacity: 0, y: -8 } : { opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : leaving ? { duration: DURATIONS_S.fast, ease: EASINGS.inOut } : { duration: DURATIONS_S.fast, ease: EASINGS.out }}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${leaving ? 'pointer-events-none absolute inset-0' : ''}`}
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
          {setup && <div className="mx-auto mt-2 w-full max-w-[640px]">{setup}</div>}
          {/* ``text-left``: the hero is centered, and the composer's
              textarea, chips and menus must not inherit it. */}
          {composer && <div className="mt-2 w-full text-left">{composer}</div>}
          {leaving && composerPlaceholderHeight !== undefined && (
            <div data-composer-placeholder aria-hidden="true" className="mt-2 w-full" style={{ height: composerPlaceholderHeight }} />
          )}
          {!isMobile && (
            <p className="text-[11px] text-(--color-text-subtle)" aria-label="Shortcuts">
              Type <kbd className="font-mono text-(--color-text-muted)">/</kbd> for commands,{' '}
              <kbd className="font-mono text-(--color-text-muted)">@</kbd> to mention a file
            </p>
          )}
        </div>

        <div className={`mx-auto mt-8 flex w-full flex-col gap-6 ${isMobile ? 'mt-6' : 'max-w-[640px]'}`}>
          {recentSessions.length > 0 && (
            <RecentSessionsList
              sessions={recentSessions}
              workspace={workspace}
              label="Continue"
              headingLevel={2}
            />
          )}
        </div>
        {!isMobile && <div className="min-h-8 flex-[62]" aria-hidden="true" />}
      </div>
    </motion.div>
  )
}

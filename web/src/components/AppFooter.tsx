/**
 * AppFooter — full-width desktop status bar (VS Code / Zed convention).
 *
 * Left cluster is workspace-scoped, right cluster is session-scoped:
 *   • left:  connected backend and its health · git branch with ahead/behind
 *            + dirty count · "N terminals running" while the workspace has
 *            live shells (they keep running with the Review panel closed)
 *   • right: fast mode · 24h spend · settings
 *
 * The model lives on the composer's run deck, the one place to read and
 * change it, so the status bar does not repeat it.
 *
 * The command palette entry lives in the header's command center, so the
 * footer carries no help button. Hidden below ``md``; mobile surfaces these
 * in the sidebar drawer footer instead.
 */
import { RollingNumber } from '@/components/ui/swap'
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  GitBranch,
  Settings,
  TerminalSquare,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { HealthDot } from './HealthDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_EVENTS, dispatchAppEvent } from '@/lib/app-events'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import { useObservabilitySummaryQuery } from '@/queries/useObservabilitySummaryQuery'
import { useActiveSessionsQuery } from '@/queries/useSessionsQuery'
import { sessionsSpending } from '@/lib/active-sessions'
import { formatSpend } from '@/utils/telemetryFormat'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceStatus } from '@/api/client'
import { cn } from '@/lib/utils'

// The summary endpoint only refreshes on demand. Spend moves only while a
// model call runs, so poll each minute then; idle, a slow poll still lets the
// 24 h window roll old spend out.
const SPEND_REFRESH_MS = 60_000
const SPEND_IDLE_REFRESH_MS = 15 * 60_000
// Tailwind `md`, the breakpoint the footer's `hidden md:flex` uses.
const FOOTER_SHOWN_QUERY = '(min-width: 768px)'

/** True while the footer is displayed: below `md` it is mounted but hidden. */
function useFooterShown(): boolean {
  const mql = useMemo(() => (typeof window === 'undefined' ? null : window.matchMedia(FOOTER_SHOWN_QUERY)), [])
  return useSyncExternalStore(
    (onChange) => {
      mql?.addEventListener('change', onChange)
      return () => mql?.removeEventListener('change', onChange)
    },
    () => mql?.matches ?? true,
    () => true,
  )
}

/** Last-24 h spend, refreshed on turn activity, never while hidden. */
function useFooterSpend(): number | undefined {
  const shown = useFooterShown()
  const spending = sessionsSpending(useActiveSessionsQuery().data)
  const query = useObservabilitySummaryQuery(1, {}, {
    enabled: shown,
    refetchInterval: spending ? SPEND_REFRESH_MS : SPEND_IDLE_REFRESH_MS,
  })
  // The last turn's cost lands after the final poll; fetch it once it ends.
  const wasSpending = useRef(spending)
  const { refetch } = query
  useEffect(() => {
    if (wasSpending.current && !spending && shown) void refetch()
    wasSpending.current = spending
  }, [spending, shown, refetch])
  return query.data?.totals.estimated_cost_usd
}

export interface AppFooterProps {
  workspace?: string | null
  /**
   * True when ``workspace`` is the chat root (see ``useChatWorkspace``). Chat
   * workspaces are not repositories, so the branch + dirty indicator is
   * dropped and the git status probe is skipped.
   */
  chatWorkspace?: boolean
  sessionId?: string | null
  sessionFastMode?: boolean
  onOpenGitChanges?: () => void
  className?: string
}

/** Shared status-bar item: 24px tall in the 28px bar, meta text, keycap hover. */
const ITEM =
  'flex h-6 min-w-0 items-center gap-1 rounded-xs px-1.5 text-meta text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)'
const ICON_ITEM =
  'flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)'

function Divider() {
  return <div className="mx-0.5 h-3 w-px shrink-0 bg-(--color-border-subtle)" aria-hidden="true" />
}

function syncLabel(ahead: number | null | undefined, behind: number | null | undefined): string | null {
  const parts: string[] = []
  if (ahead) parts.push(`${ahead} to push`)
  if (behind) parts.push(`${behind} to pull`)
  return parts.length > 0 ? parts.join(', ') : null
}

/**
 * Shells of ``workspace`` that are still alive, the same ones the dock asks
 * before closing. Terminals are keyed by the workspace path (their
 * ``contextKey``), so another workspace's shells never count here. A number,
 * so a shell's output or title does not re-render the footer.
 */
function useRunningTerminalCount(workspace: string | null | undefined): number {
  return useTerminalStore((state) => {
    if (!workspace) return 0
    let running = 0
    for (const meta of Object.values(state.sessions)) {
      if (meta.contextKey === workspace && (meta.status === 'connected' || meta.status === 'connecting')) running += 1
    }
    return running
  })
}

export const AppFooter = memo(function AppFooter({
  workspace,
  chatWorkspace = false,
  sessionFastMode,
  onOpenGitChanges,
  className,
}: AppFooterProps) {
  const { os } = usePlatform()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const spend = useFooterSpend()
  const spendLabel = spend === undefined ? null : formatSpend(spend)
  const terminals = useRunningTerminalCount(workspace)
  const terminalsLabel = `${terminals} ${terminals === 1 ? 'terminal' : 'terminals'} running`

  const isProject = Boolean(workspace) && !chatWorkspace
  const statusQuery = useQuery({
    queryKey: queryKeys.coding.status(workspace ?? ''),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace!, signal),
    enabled: isProject,
    staleTime: 10_000,
  })

  const gitStatus = statusQuery.data
  const isGit = gitStatus?.is_git_repo === true
  const branch = gitStatus?.branch
  const staged = gitStatus?.dirty?.staged ?? 0
  const unstaged = gitStatus?.dirty?.unstaged ?? 0
  const untracked = gitStatus?.dirty?.untracked ?? 0
  const dirtyTotal = staged + unstaged + untracked
  const ahead = gitStatus?.commits_ahead ?? null
  const behind = gitStatus?.commits_behind ?? null
  const sync = syncLabel(ahead, behind)

  const branchTooltip = [
    `Git branch: ${branch}`,
    dirtyTotal > 0 ? `${dirtyTotal} changed files` : null,
    sync,
  ].filter(Boolean).join(' · ')
  const branchLabel = [
    `Git branch ${branch}`,
    dirtyTotal > 0 ? `${dirtyTotal} changed files` : null,
    sync,
  ].filter(Boolean).join(', ')

  return (
    <footer
      className={cn(
        'hidden h-(--spacing-status-bar) shrink-0 select-none items-center justify-between gap-2 border-t border-(--color-border) bg-(--bg-page) px-2 text-meta text-(--color-text-muted) md:flex dark:bg-(--bg-sidebar)',
        className,
      )}
      aria-label="Status bar"
      data-focus-region="status"
    >
      {/* Left cluster — workspace scope: connection, repository state. */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <HealthDot labeled />

        {isProject && isGit && branch && (
          <>
            <Divider />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenGitChanges}
                    className={cn(ITEM, 'max-w-[240px] font-mono')}
                    aria-label={branchLabel}
                  >
                    <GitBranch size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                    <span className="truncate">{branch}</span>
                    {ahead ? <span className="shrink-0" aria-label={`${ahead} commits to push`}>↑{ahead}</span> : null}
                    {behind ? <span className="shrink-0" aria-label={`${behind} commits to pull`}>↓{behind}</span> : null}
                    {dirtyTotal > 0 && (
                      <span className="shrink-0 rounded-xs bg-(--accent-orange-soft) px-1 text-(--accent-orange-text)">{dirtyTotal} changed</span>
                    )}
                  </button>
                }
              />
              <TooltipContent>
                <span className="block">{branchTooltip}</span>
                <span className="block text-(--color-text-muted)">{`Open Git (${shortcutLabel(APP_SHORTCUTS.openGit, os)})`}</span>
              </TooltipContent>
            </Tooltip>
          </>
        )}

        {terminals > 0 && (
          <>
            <Divider />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    // Opens the Review panel on the last shell.
                    onClick={() => dispatchAppEvent(APP_EVENTS.openTerminal)}
                    className={cn(ITEM, 'shrink-0')}
                  >
                    <TerminalSquare size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                    <span className="whitespace-nowrap">{terminalsLabel}</span>
                  </button>
                }
              />
              <TooltipContent>
                <span className="block">Terminals keep running while hidden</span>
                <span className="block text-(--color-text-muted)">Open terminal</span>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Right cluster — session scope, then app utilities. */}
      <div className="flex min-w-0 shrink items-center justify-end gap-0.5">
        {sessionFastMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                // A badge, not a control: no Tab stop. Its tooltip is a hover
                // detail; the badge's own label says what it means.
                <span
                  role="img"
                  aria-label="Fast mode is on"
                  data-status-fast=""
                  className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-xs bg-(--accent-orange-soft) px-1 font-mono text-meta font-medium text-(--accent-orange-text)"
                >
                  <Zap size={12} aria-hidden="true" />
                  <span aria-hidden="true">fast</span>
                </span>
              }
            />
            <TooltipContent>Fast mode is on: the provider's faster, pricier tier</TooltipContent>
          </Tooltip>
        )}

        {sessionFastMode && <Divider />}

        {spendLabel && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => openTelemetry({ days: 1 })}
                  className={cn(ITEM, 'font-mono tabular-nums')}
                  aria-label={`Spend in the last 24 hours: ${spendLabel}`}
                >
                  <RollingNumber text={spendLabel} value={spend ?? 0} />
                  <span className="text-(--color-text-subtle)">· 24h</span>
                </button>
              }
            />
            <TooltipContent>
              <span className="block">Estimated spend, last 24 hours</span>
              <span className="block text-(--color-text-muted)">Open usage</span>
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => openSettings()}
                className={ICON_ITEM}
                aria-label="Settings"
              >
                <Settings size={12} aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent>{`Settings (${shortcutLabel(APP_SHORTCUTS.settings, os)})`}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  )
})

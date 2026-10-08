/**
 * AppFooter — full-width desktop status bar (VS Code / Zed convention).
 *
 * Left cluster is workspace-scoped, right cluster is session-scoped:
 *   • left:  connected backend and its health · git branch with ahead/behind
 *            + dirty count
 *   • right: active model (thinking level) · fast mode · 24h spend · settings
 *
 * The command palette entry lives in the header's command center, so the
 * footer carries no help button. Hidden below ``md``; mobile surfaces these
 * in the sidebar drawer footer instead.
 */
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  GitBranch,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { HealthDot } from './HealthDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { useSettingsStore } from '@/stores/useSettingsStore'
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
  sessionModel?: string | null
  /**
   * The lead agent's configured model. ``sessionModel`` is null until the
   * session overrides it, so the footer shows this instead.
   */
  defaultModel?: string | null
  /** The lead agent's configured thinking level, paired with ``defaultModel``. */
  defaultThinkingLevel?: string | null
  sessionThinkingLevel?: string | null
  sessionFastMode?: boolean
  onToggleSessionSettings?: () => void
  onOpenGitChanges?: () => void
  className?: string
}

/** Shared status-bar item: 20px tall, 11px text, keycap hover. */
const ITEM =
  'flex h-5 min-w-0 items-center gap-1 rounded-xs px-1.5 text-[11px] text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'
const ICON_ITEM =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'

function Divider() {
  return <div className="mx-0.5 h-3 w-px shrink-0 bg-(--color-border-subtle)" aria-hidden="true" />
}

function syncLabel(ahead: number | null | undefined, behind: number | null | undefined): string | null {
  const parts: string[] = []
  if (ahead) parts.push(`${ahead} to push`)
  if (behind) parts.push(`${behind} to pull`)
  return parts.length > 0 ? parts.join(', ') : null
}

export const AppFooter = memo(function AppFooter({
  workspace,
  chatWorkspace = false,
  sessionModel,
  defaultModel,
  defaultThinkingLevel,
  sessionThinkingLevel,
  sessionFastMode,
  onToggleSessionSettings,
  onOpenGitChanges,
  className,
}: AppFooterProps) {
  const { os } = usePlatform()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const activeModel = sessionModel || defaultModel || null
  // Mirrors the backend: a session model override builds its own provider,
  // which carries only the session's level, never the agent's.
  const modelOverridden = Boolean(sessionModel) && sessionModel !== defaultModel
  const activeThinkingLevel = sessionThinkingLevel || (modelOverridden ? null : defaultThinkingLevel) || null
  const sessionSettingsShortcut = shortcutLabel(APP_SHORTCUTS.sessionSettings, os)
  const spend = useFooterSpend()
  const spendLabel = spend === undefined ? null : formatSpend(spend)

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

  return (
    <footer
      className={cn(
        'hidden h-(--spacing-status-bar) shrink-0 select-none items-center justify-between gap-2 border-t border-(--color-border) bg-(--bg-page) px-2 text-[11px] text-(--color-text-muted) md:flex dark:bg-(--bg-sidebar)',
        className,
      )}
      role="status"
      aria-label="Application status"
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
                  >
                    <GitBranch size={11} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                    <span className="truncate">{branch}</span>
                    {ahead ? <span className="shrink-0" aria-label={`${ahead} commits to push`}>↑{ahead}</span> : null}
                    {behind ? <span className="shrink-0" aria-label={`${behind} commits to pull`}>↓{behind}</span> : null}
                    {dirtyTotal > 0 && (
                      <span className="shrink-0 rounded-xs bg-(--accent-orange-soft) px-1 font-semibold text-(--accent-orange-text)">*{dirtyTotal}</span>
                    )}
                  </button>
                }
              />
              <TooltipContent>{branchTooltip}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Right cluster — session scope, then app utilities. */}
      <div className="flex min-w-0 shrink items-center justify-end gap-0.5">
        {activeModel && (
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={
                <button
                  type="button"
                  onClick={onToggleSessionSettings}
                  className={cn(ITEM, 'max-w-[320px] font-mono lg:max-w-[440px]')}
                >
                  <Sparkles size={11} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
                  <span className="truncate">{activeModel}</span>
                  {activeThinkingLevel && activeThinkingLevel !== 'off' && (
                    <span className="shrink-0 text-(--color-text-subtle)">({activeThinkingLevel})</span>
                  )}
                </button>
              }
            />
            <TooltipContent>{`Active Model: ${activeModel}${activeThinkingLevel ? ` (thinking: ${activeThinkingLevel})` : ''} (${sessionSettingsShortcut})`}</TooltipContent>
          </Tooltip>
        )}

        {sessionFastMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-xs bg-(--accent-orange-soft) px-1 font-mono text-[11px] font-medium text-(--accent-orange-text)">
                  <Zap size={11} aria-hidden="true" />
                  <span>fast</span>
                </span>
              }
            />
            <TooltipContent>Fast mode active</TooltipContent>
          </Tooltip>
        )}

        {(activeModel || sessionFastMode) && <Divider />}

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
                  <span>{spendLabel}</span>
                  <span className="text-(--color-text-subtle)">24h</span>
                </button>
              }
            />
            <TooltipContent>Spend in the last 24 hours · Open Telemetry</TooltipContent>
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

/**
 * AppFooter — full-width application status bar (footer).
 *
 * Sits at the bottom of the window across the entire width (under the sidebar
 * and main chat), matching modern code editor status bars (Zed / VS Code).
 *
 * Left cluster (Context & Health):
 *   • HealthDot / Backend connection status
 *   • Workspace git branch + dirty change indicator (when in coding mode)
 *   • Active model & thinking level pill (clicking opens session settings)
 *   • Fast mode indicator (when active)
 *
 * Right cluster (Metrics & Utility):
  *   • View mode toggle (Agent / Split)
  *   • Scheduler shortcut button
  *   • ThemeToggle (collapsed 3-way cycler)
  *   • Help button (Command Palette ⌘⇧P)
 *   • Settings button (Settings modal ⌘,)
 */
import { memo } from 'react'
import {
  CalendarClock,
  GitBranch,
  HelpCircle,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { HealthDot } from './HealthDot'
import { ThemeToggle } from './ThemeToggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ViewToggle, type ViewMode } from '@/components/ui/view-toggle'
import { usePlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { queryKeys } from '@/queries/keys'
import { getCodingWorkspaceStatus } from '@/api/client'
import { cn } from '@/lib/utils'

export interface AppFooterProps {
  workspace?: string | null
  sessionId?: string | null
  sessionModel?: string | null
  sessionThinkingLevel?: string | null
  sessionFastMode?: boolean
  viewMode?: ViewMode
  onViewModeChange?: (mode: ViewMode) => void
  onToggleScheduler?: () => void
  onToggleSessionSettings?: () => void
  onTogglePalette?: () => void
  onOpenGitChanges?: () => void
  className?: string
}

function formatModelDisplay(model: string): string {
  return model
}

export const AppFooter = memo(function AppFooter({
  workspace,
  sessionId: _sessionId,
  sessionModel,
  sessionThinkingLevel,
  sessionFastMode,
  viewMode,
  onViewModeChange,
  onToggleScheduler,
  onToggleSessionSettings,
  onTogglePalette,
  onOpenGitChanges,
  className,
}: AppFooterProps) {
  const { os } = usePlatform()
  const openSettings = useSettingsStore((s) => s.openSettings)

  const isCoding = Boolean(workspace)
  const statusQuery = useQuery({
    queryKey: queryKeys.coding.status(workspace ?? ''),
    queryFn: () => getCodingWorkspaceStatus(workspace!),
    enabled: isCoding,
    staleTime: 10_000,
  })

  const gitStatus = statusQuery.data
  const isGit = gitStatus?.is_git_repo === true
  const branch = gitStatus?.branch
  const staged = gitStatus?.dirty?.staged ?? 0
  const unstaged = gitStatus?.dirty?.unstaged ?? 0
  const untracked = gitStatus?.dirty?.untracked ?? 0
  const dirtyTotal = staged + unstaged + untracked

  return (
    <footer
      className={cn(
        'hidden md:flex h-6 shrink-0 items-center justify-between border-t border-(--color-border-subtle) bg-(--bg-page) px-2 text-[11px] select-none text-(--color-text-muted)',
        className,
      )}
      role="status"
      aria-label="Application status"
    >
      {/* Left cluster: Connection, Git / Workspace, Model */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <HealthDot>
          <span>local</span>
        </HealthDot>

        {isCoding && isGit && branch && (
          <>
            <div className="mx-0.5 h-3 w-px bg-(--color-border-subtle)" aria-hidden="true" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenGitChanges}
                    className="flex h-5 max-w-[180px] items-center gap-1 rounded-sm px-1.5 font-mono text-[10.5px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring)"
                  >
                    <GitBranch size={11} className="shrink-0 text-(--color-text-subtle)" />
                    <span className="truncate">{branch}</span>
                    {dirtyTotal > 0 && (
                      <span className="shrink-0 rounded-sm bg-(--accent-orange-soft) px-1 font-mono text-[9px] font-semibold text-(--accent-orange-text)">*{dirtyTotal}</span>
                    )}
                  </button>
                }
              />
              <TooltipContent>{`Git branch: ${branch}${dirtyTotal > 0 ? ` (${dirtyTotal} changed files)` : ''}`}</TooltipContent>
            </Tooltip>
          </>
        )}

        {sessionModel && (
          <>
            <div className="mx-0.5 h-3 w-px bg-(--color-border-subtle)" aria-hidden="true" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onToggleSessionSettings}
                    className="flex h-5 max-w-[340px] lg:max-w-[480px] xl:max-w-[600px] items-center gap-1 rounded-sm px-1.5 font-mono text-[10.5px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--focus-ring)"
                  >
                    <Sparkles size={11} className="shrink-0 text-(--color-accent)" />
                    <span className="truncate">{formatModelDisplay(sessionModel)}</span>
                    {sessionThinkingLevel && sessionThinkingLevel !== 'off' && (
                      <span className="shrink-0 text-[9.5px] text-(--color-text-subtle)">({sessionThinkingLevel})</span>
                    )}
                  </button>
                }
              />
              <TooltipContent>{`Active Model: ${sessionModel}${sessionThinkingLevel ? ` (thinking: ${sessionThinkingLevel})` : ''} (${formatShortcut('A', os, { shift: true })})`}</TooltipContent>
            </Tooltip>
          </>
        )}

        {sessionFastMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex h-4 items-center gap-0.5 rounded-sm bg-(--accent-orange-soft) px-1 font-mono text-[9px] font-medium text-(--accent-orange-text)">
                  <Zap size={8.5} />
                  <span>fast</span>
                </span>
              }
            />
            <TooltipContent>Fast mode active</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Right cluster: ViewMode, Scheduler, Utilities */}
      <div className="flex shrink-0 items-center gap-0.5 pl-2">
        {viewMode && onViewModeChange && (
          <>
            <ViewToggle
              value={viewMode}
              onValueChange={onViewModeChange}
              compact
            />
            <div className="mx-0.5 h-3 w-px bg-(--color-border-subtle)" aria-hidden="true" />
          </>
        )}

        {onToggleScheduler && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onToggleScheduler}
                  className="flex h-5 w-5 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Scheduler"
                >
                  <CalendarClock size={12} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Scheduler (${formatShortcut('S', os)})`}</TooltipContent>
          </Tooltip>
        )}

        <ThemeToggle collapsed compact />

        {onTogglePalette && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onTogglePalette}
                  className="flex h-5 w-5 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                  aria-label="Help and shortcuts"
                >
                  <HelpCircle size={12} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent>{`Help and shortcuts (${formatShortcut('P', os, { shift: true })})`}</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => openSettings()}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                aria-label="Settings"
              >
                <Settings size={12} aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent>{`Settings (${formatShortcut(',', os)})`}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  )
})

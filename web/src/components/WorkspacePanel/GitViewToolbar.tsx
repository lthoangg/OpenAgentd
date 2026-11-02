/**
 * GitViewToolbar — the single 32px toolbar under the Git review tab.
 *
 * One segmented control on every platform — Changes and History — plus the
 * Changes view's expand-all on the right. History is the commit list
 * (stored as ``commits``). The segments are real ARIA tabs; the caller
 * renders the matching ``tabpanel`` using ``gitViewPanelId`` /
 * ``gitViewTabId`` so the ids line up.
 */
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommitSyncBadge } from './CommitDetail'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

export type GitSubTab = 'changes' | 'commits'

export const gitViewTabId = (idBase: string, tab: GitSubTab) => `${idBase}-${tab}-tab`
export const gitViewPanelId = (idBase: string) => `${idBase}-panel`

export interface GitViewToolbarProps {
  idBase: string
  subTab: GitSubTab
  onSubTabChange: (tab: GitSubTab) => void
  changedCount: number
  commitsAhead: number | null
  commitsBehind: number | null
  upstream: string | null
  mobile: boolean
  /** ``null`` when there is nothing to expand. */
  allExpanded: boolean | null
  onToggleExpandAll: () => void
}

export function GitViewToolbar({
  idBase,
  subTab,
  onSubTabChange,
  changedCount,
  commitsAhead,
  commitsBehind,
  upstream,
  mobile,
  allExpanded,
  onToggleExpandAll,
}: GitViewToolbarProps) {
  const trigger = (tab: GitSubTab) => ({
    value: tab,
    id: gitViewTabId(idBase, tab),
    'aria-controls': gitViewPanelId(idBase),
  })
  const expandLabel = allExpanded ? 'Collapse all diffs' : 'Expand all diffs'

  return (
    <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) px-2">
      <Tabs
        value={subTab}
        onValueChange={(value) => {
          if (value === 'changes' || value === 'commits') onSubTabChange(value)
        }}
        className={cn('min-w-0', mobile && 'flex-1')}
      >
        <TabsList size="sm" aria-label="Git view" className={mobile ? 'w-full' : undefined}>
          <TabsTrigger {...trigger('changes')}>Changes ({changedCount})</TabsTrigger>
          <TabsTrigger {...trigger('commits')}>
            <span className="inline-flex items-center gap-1">
              History
              {commitsAhead != null && commitsAhead > 0 && (
                <CommitSyncBadge count={commitsAhead} direction="ahead" upstream={upstream} />
              )}
              {commitsBehind != null && commitsBehind > 0 && (
                <CommitSyncBadge count={commitsBehind} direction="behind" upstream={upstream} />
              )}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="ml-auto flex shrink-0 items-center gap-1 select-none">
        {subTab === 'changes' && allExpanded !== null && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={expandLabel}
                  onClick={onToggleExpandAll}
                  className={DOCK_ACTION_BUTTON_CLASS}
                >
                  {allExpanded
                    ? <ChevronsDownUp size={14} aria-hidden="true" />
                    : <ChevronsUpDown size={14} aria-hidden="true" />}
                </button>
              }
            />
            <TooltipContent side="bottom">{expandLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

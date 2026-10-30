/**
 * GitViewToolbar — the single 32px toolbar under the Git review tab.
 *
 * One segmented control on every platform — Changes and History — plus the
 * view's options on the right (expand-all for Changes; Graph, and with it
 * All branches, for History). History covers two stored sub-tabs: the
 * commit list (``commits``) and the graph (``tree``). The segments are real
 * ARIA tabs; the caller renders the matching ``tabpanel`` using
 * ``gitViewPanelId`` / ``gitViewTabId`` so the ids line up.
 */
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommitSyncBadge } from './CommitDetail'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

export type GitSubTab = 'changes' | 'commits' | 'tree'
type GitViewSegment = 'changes' | 'history'

const segmentOf = (tab: GitSubTab): GitViewSegment => (tab === 'changes' ? 'changes' : 'history')
export const gitViewTabId = (idBase: string, tab: GitSubTab) => `${idBase}-${segmentOf(tab)}-tab`
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
  allBranches: boolean
  onAllBranchesChange: (value: boolean) => void
}

const CHECKBOX_CLASS = 'border-(--color-border) bg-(--bg-card) checked:border-(--color-border-strong) checked:bg-(--bg-key)'

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
  allBranches,
  onAllBranchesChange,
}: GitViewToolbarProps) {
  const trigger = (segment: GitViewSegment) => ({
    value: segment,
    id: `${idBase}-${segment}-tab`,
    'aria-controls': gitViewPanelId(idBase),
  })
  const expandLabel = allExpanded ? 'Collapse all diffs' : 'Expand all diffs'

  return (
    <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) px-2">
      <Tabs
        value={segmentOf(subTab)}
        onValueChange={(value) => {
          if (value === 'changes') onSubTabChange('changes')
          else if (value === 'history' && subTab === 'changes') onSubTabChange('commits')
        }}
        className={cn('min-w-0', mobile && 'flex-1')}
      >
        <TabsList size="sm" aria-label="Git view" className={mobile ? 'w-full' : undefined}>
          <TabsTrigger {...trigger('changes')}>Changes ({changedCount})</TabsTrigger>
          <TabsTrigger {...trigger('history')}>
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
        {subTab !== 'changes' && (
          <label className="flex h-7 cursor-pointer items-center gap-1.5 px-1 text-[11px] text-(--color-text-muted)">
            <Checkbox
              checked={subTab === 'tree'}
              onChange={(event) => onSubTabChange(event.currentTarget.checked ? 'tree' : 'commits')}
              className={CHECKBOX_CLASS}
              checkClassName="peer-checked:text-(--color-text)"
            />
            <span className="whitespace-nowrap">Graph view</span>
          </label>
        )}
        {subTab === 'tree' && (
          <label className="flex h-7 cursor-pointer items-center gap-1.5 px-1 text-[11px] text-(--color-text-muted)">
            <Checkbox
              checked={allBranches}
              onChange={(event) => onAllBranchesChange(event.currentTarget.checked)}
              className={CHECKBOX_CLASS}
              checkClassName="peer-checked:text-(--color-text)"
            />
            <span className="whitespace-nowrap">All branches</span>
          </label>
        )}
      </div>
    </div>
  )
}

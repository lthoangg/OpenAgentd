/**
 * GitViewToolbar — the single 32px toolbar under the Git review tab.
 *
 * One segmented control on every platform — Changes and History — plus the
 * view's options on the right: expand-all for Changes, and for History one
 * "View" menu (Graph view, and with it All branches) that is the same on
 * every platform. History covers two stored sub-tabs: the commit list
 * (``commits``) and the graph (``tree``). The segments are real ARIA tabs;
 * the caller renders the matching ``tabpanel`` using ``gitViewPanelId`` /
 * ``gitViewTabId`` so the ids line up.
 */
import { useState } from 'react'
import { Check, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu } from '@/components/ui/context-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommitSyncBadge } from './CommitDetail'
import { DOCK_ACTION_BUTTON_CLASS, DOCK_TEXT_ACTION_CLASS } from './dock-tab-styles'

export type GitSubTab = 'changes' | 'commits' | 'tree'
type GitViewSegment = 'changes' | 'history'

const segmentOf = (tab: GitSubTab): GitViewSegment => (tab === 'changes' ? 'changes' : 'history')
export const gitViewTabId = (idBase: string, tab: GitSubTab) => `${idBase}-${segmentOf(tab)}-tab`
export const gitViewPanelId = (idBase: string) => `${idBase}-panel`

/** Width the View menu is laid out for, so it opens right-aligned under its button. */
const VIEW_MENU_WIDTH = 176

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

/** One checkable row of the View menu; the tick sits in a fixed slot so labels line up. */
function ViewMenuCheckbox({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: string }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className={CONTEXT_MENU_ITEM_CLASS} onClick={onToggle}>
      <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">
        {checked && <Check size={12} />}
      </span>
      {children}
    </button>
  )
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
  allBranches,
  onAllBranchesChange,
}: GitViewToolbarProps) {
  const [viewMenuAt, setViewMenuAt] = useState<{ x: number; y: number } | null>(null)
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
          // One menu on every platform, so the tabs keep their width on a phone
          // and a desktop has no 11px checkboxes to hit.
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setViewMenuAt({ x: rect.right - VIEW_MENU_WIDTH, y: rect.bottom + 2 })
            }}
            className={DOCK_TEXT_ACTION_CLASS}
            aria-haspopup="menu"
            aria-expanded={viewMenuAt !== null}
          >
            View
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        )}
      </div>
      {viewMenuAt && (
        <ContextMenu at={viewMenuAt} label="View options" onDismiss={() => setViewMenuAt(null)} className="w-44">
          <ViewMenuCheckbox
            checked={subTab === 'tree'}
            onToggle={() => {
              setViewMenuAt(null)
              onSubTabChange(subTab === 'tree' ? 'commits' : 'tree')
            }}
          >
            Graph view
          </ViewMenuCheckbox>
          {subTab === 'tree' && (
            <ViewMenuCheckbox
              checked={allBranches}
              onToggle={() => {
                setViewMenuAt(null)
                onAllBranchesChange(!allBranches)
              }}
            >
              All branches
            </ViewMenuCheckbox>
          )}
        </ContextMenu>
      )}
    </div>
  )
}

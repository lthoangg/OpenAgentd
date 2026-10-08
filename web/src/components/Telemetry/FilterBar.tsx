/**
 * FilterBar — time range, workspace, model, and session for the telemetry
 * overview.
 *
 * Options come from the summary's ``facets`` (the whole window, not the
 * current selection), so picking a workspace never hides the others. A
 * selection that is no longer in the window stays listed so the trigger can
 * still show it. Sessions are too many for a picker: one is chosen from the
 * Sessions card or the palette and shows here as a removable chip.
 */
import { Loader2, X } from 'lucide-react'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TELEMETRY_RANGES, type TelemetryRange } from '@/stores/useTelemetryStore'
import { modelName, workspaceName } from './model'

const ALL = '__all__'

const RANGE_LABEL: Record<TelemetryRange, string> = { 1: '24h', 7: '7d', 30: '30d', 90: '90d' }
const RANGE_TITLE: Record<TelemetryRange, string> = {
  1: 'Last 24 hours',
  7: 'Last 7 days',
  30: 'Last 30 days',
  90: 'Last 90 days',
}

export interface FilterBarProps {
  days: TelemetryRange
  onDaysChange: (days: TelemetryRange) => void
  workspace: string | null
  onWorkspaceChange: (workspace: string | null) => void
  model: string | null
  onModelChange: (model: string | null) => void
  session: string | null
  /** Display name for ``session`` (title, or a fallback while loading). */
  sessionLabel: string | null
  onSessionChange: (session: string | null) => void
  /** ``null`` when the backend predates filters: the pickers are hidden. */
  facets: { workspaces: string[]; models: string[] } | null
  onClear: () => void
  fetching: boolean
}

function withSelection(options: string[], selected: string | null): string[] {
  return selected && !options.includes(selected) ? [selected, ...options] : options
}

export function FilterBar({
  days,
  onDaysChange,
  workspace,
  onWorkspaceChange,
  model,
  onModelChange,
  session,
  sessionLabel,
  onSessionChange,
  facets,
  onClear,
  fetching,
}: FilterBarProps) {
  const workspaces = facets ? withSelection(facets.workspaces, workspace) : []
  const models = facets ? withSelection(facets.models, model) : []
  const filtered = workspace !== null || model !== null || session !== null

  return (
    <div className="scrollbar-none flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-(--color-border) px-3 sm:px-4">
      <SegmentedControl
        label="Time range"
        size="sm"
        value={String(days)}
        onChange={(next) => onDaysChange(Number(next) as TelemetryRange)}
        itemClassName="font-mono"
        tooltipSide="bottom"
        options={TELEMETRY_RANGES.map((range) => ({
          value: String(range),
          label: RANGE_LABEL[range],
          tooltip: RANGE_TITLE[range],
        }))}
      />

      {workspaces.length > 0 && (
        <Dropdown
          aria-label="Workspace"
          value={workspace ?? ALL}
          onValueChange={(value) => onWorkspaceChange(value === ALL ? null : value)}
          trigger="All workspaces"
          className="h-7 max-w-52 shrink-0 text-xs"
        >
          <DropdownItem value={ALL}>All workspaces</DropdownItem>
          {workspaces.map((path) => (
            <DropdownItem key={path} value={path} title={path}>
              {workspaceName(path)}
            </DropdownItem>
          ))}
        </Dropdown>
      )}

      {models.length > 0 && (
        <Dropdown
          aria-label="Model"
          value={model ?? ALL}
          onValueChange={(value) => onModelChange(value === ALL ? null : value)}
          trigger="All models"
          className="h-7 max-w-60 shrink-0 text-xs"
        >
          <DropdownItem value={ALL}>All models</DropdownItem>
          {models.map((pm) => (
            <DropdownItem key={pm} value={pm} title={pm}>
              <span className="truncate font-mono">{modelName(pm)}</span>
            </DropdownItem>
          ))}
        </Dropdown>
      )}

      {session !== null && (
        <span className="flex h-7 max-w-64 shrink-0 items-center gap-1 rounded-sm border border-(--color-border-strong) bg-(--bg-card) pr-0.5 pl-2 text-xs text-(--color-text)">
          <span className="text-(--color-text-muted)">Session</span>
          <span className="min-w-0 truncate font-medium">{sessionLabel ?? 'Loading…'}</span>
          <button
            type="button"
            onClick={() => onSessionChange(null)}
            aria-label="Remove session filter"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}

      {filtered && (
        <button
          type="button"
          onClick={onClear}
          className="h-7 shrink-0 rounded-sm px-2 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
        >
          Clear filters
        </button>
      )}

      <div className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center" aria-live="polite">
        {fetching && (
          <>
            <Loader2 size={13} className="animate-spin text-(--color-text-subtle)" aria-hidden="true" />
            <span className="sr-only">Updating</span>
          </>
        )}
      </div>
    </div>
  )
}

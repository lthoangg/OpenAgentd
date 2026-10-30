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
import { cn } from '@/lib/utils'
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
  /** Recent turns show failed turns only. */
  errorsOnly?: boolean
  onErrorsOnlyChange?: (errorsOnly: boolean) => void
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
  errorsOnly = false,
  onErrorsOnlyChange,
}: FilterBarProps) {
  const workspaces = facets ? withSelection(facets.workspaces, workspace) : []
  const models = facets ? withSelection(facets.models, model) : []
  const filtered = workspace !== null || model !== null || session !== null || errorsOnly

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--color-border) px-3 py-2 sm:px-4">
      <span className="text-[11px] text-(--color-text-subtle) max-sm:sr-only" aria-hidden="true">Range</span>
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

      {facets === null ? (
        <span className="text-[11px] text-(--color-text-subtle)">Update the server to filter by workspace or model.</span>
      ) : null}

      {workspaces.length > 0 && (
        <Dropdown
          aria-label="Workspace"
          value={workspace ?? ALL}
          onValueChange={(value) => onWorkspaceChange(value === ALL ? null : value)}
          renderValue={(value, label) => (
            <>
              <span className="text-(--color-text-muted)">Workspace:</span>
              <span className="min-w-0 truncate">{value === ALL ? 'All' : label}</span>
            </>
          )}
          trigger="All workspaces"
          className="h-7 max-w-60 shrink-0 text-xs pointer-coarse:min-h-11"
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
          renderValue={(value, label) => (
            <>
              <span className="text-(--color-text-muted)">Model:</span>
              <span className="min-w-0 truncate">{value === ALL ? 'All' : label}</span>
            </>
          )}
          trigger="All models"
          className="h-7 max-w-64 shrink-0 text-xs pointer-coarse:min-h-11"
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
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:size-11"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}

      {onErrorsOnlyChange && (
        <button
          type="button"
          aria-pressed={errorsOnly}
          onClick={() => onErrorsOnlyChange(!errorsOnly)}
          className={cn(
            'h-7 shrink-0 rounded-sm border px-2.5 text-xs transition-colors pointer-coarse:min-h-11',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--focus-ring)',
            errorsOnly
              ? 'border-(--color-error)/45 bg-(--color-error-subtle) text-(--color-error)'
              : 'border-(--color-border) bg-(--bg-card) text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)',
          )}
        >
          Failed only
        </button>
      )}

      {filtered && (
        <button
          type="button"
          onClick={onClear}
          className="h-7 shrink-0 rounded-sm px-2 text-xs text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:min-h-11"
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

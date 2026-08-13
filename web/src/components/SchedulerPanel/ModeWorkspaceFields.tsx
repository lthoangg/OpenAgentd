import { useMemo } from 'react'
import type { ScheduledTaskMode } from '@/api/types'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { loadCodingWorkspaceEntries, workspaceLabel } from '@/utils/workspace'

export function ModeWorkspaceFields({
  mode,
  workspace,
  onChange,
  workspaceError,
  workspaceErrorId,
}: {
  mode: ScheduledTaskMode
  workspace: string | null
  /** Emits both fields together so the parent applies them in a single
   *  update — preventing the stale-snapshot bug where switching
   *  ``coding → normal`` would clear the workspace but leave ``mode``
   *  unchanged (two sequential updates on the same snapshot). */
  onChange: (next: { mode: ScheduledTaskMode; workspace: string | null }) => void
  workspaceError?: string
  workspaceErrorId?: string
}) {
  const savedWorkspaces = useMemo(() => {
    const paths = loadCodingWorkspaceEntries().map((entry) => entry.path)
    if (workspace && !paths.includes(workspace)) paths.push(workspace)
    return paths.sort()
  }, [workspace])

  const modeOptions: { key: ScheduledTaskMode; label: string }[] = [
    { key: 'normal', label: 'Normal' },
    { key: 'coding', label: 'Coding' },
  ]

  return (
    <div>
      <label className="block text-sm font-medium text-(--color-text)">Routing</label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Task mode"
          // ``inline-flex`` so two short labels ("Normal" / "Coding") do not
          // sprawl across the full form width.
          className="inline-flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-0.5"
        >
          {modeOptions.map((opt) => {
            const active = mode === opt.key
            return (
              <button
                key={opt.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  onChange({
                    mode: opt.key,
                    // Drop the workspace when leaving coding mode; preserve it
                    // when staying on coding so the user does not lose their
                    // typed-in path by tapping the active tab.
                    workspace: opt.key === 'coding' ? workspace : null,
                  })
                }}
                className={
                  'rounded-xs border border-transparent px-2.5 py-1 text-[11px] font-medium transition-colors ' +
                  (active
                    ? 'border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
                    : 'text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)')
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        {mode === 'coding' && (
          <div className="w-full min-w-0 sm:w-72 sm:shrink-0">
            <Dropdown
              value={workspace ?? ''}
              onValueChange={(v) => onChange({ mode, workspace: v || null })}
              trigger={workspace ? workspaceLabel(workspace) : 'Select a saved workspace…'}
              className="w-full max-w-full px-2 py-1 text-[11px]"
              panelClassName="max-w-[min(22rem,calc(100vw-2rem))]"
              aria-label="Select workspace"
              aria-invalid={!!workspaceError}
              aria-describedby={workspaceError ? workspaceErrorId : undefined}
            >
              {savedWorkspaces.map((path) => (
                <DropdownItem key={path} value={path}>
                  {workspaceLabel(path)}
                </DropdownItem>
              ))}
            </Dropdown>
          </div>
        )}
      </div>
      {workspaceError && workspaceErrorId && (
        <p id={workspaceErrorId} className="mt-1 text-xs text-(--color-error)">{workspaceError}</p>
      )}
      <p className="mt-1 text-xs text-(--color-text-muted)">
        {mode === 'normal' ? (
          'Delivers to the default team lead.'
        ) : (
          <>
            Delivers to the lead of the coding team for the selected workspace.{' '}
            <span>Workspaces come from saved coding workspaces.</span>
          </>
        )}
      </p>
    </div>
  )
}

// ── Panel root ──────────────────────────────────────────────────────────────

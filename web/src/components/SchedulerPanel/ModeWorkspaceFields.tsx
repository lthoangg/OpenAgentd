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
      <label className="mb-1 block text-xs font-medium text-(--color-text-2)">Routing</label>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Task mode"
          className="inline-flex h-8 max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-sm border border-(--color-border) bg-(--bg-key)/60 p-0.5"
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
                    workspace: opt.key === 'coding' ? workspace : null,
                  })
                }}
                className={`flex h-7 items-center rounded-xs border px-2.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-(--color-border-strong) bg-(--bg-card) text-(--color-text) shadow-2xs font-semibold'
                    : 'border-transparent text-(--color-text-muted) hover:bg-(--bg-key)/60 hover:text-(--color-text)'
                }`}
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
              className="h-8 w-full max-w-full rounded-sm border-(--color-border) bg-(--bg-page) px-2.5 text-xs"
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
            <span className="text-(--color-text-subtle)">Workspaces come from saved coding workspaces.</span>
          </>
        )}
      </p>
    </div>
  )
}

// ── Panel root ──────────────────────────────────────────────────────────────

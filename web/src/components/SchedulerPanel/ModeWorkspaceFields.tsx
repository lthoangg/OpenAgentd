import { useMemo } from 'react'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { loadCodingWorkspaceEntries, workspaceLabel } from '@/utils/workspace'

export function ModeWorkspaceFields({
  workspace,
  onChange,
  workspaceError,
  workspaceErrorId,
}: {
  workspace: string | null
  onChange: (workspace: string | null) => void
  workspaceError?: string
  workspaceErrorId?: string
}) {
  const savedWorkspaces = useMemo(() => {
    const paths = loadCodingWorkspaceEntries().map((entry) => entry.path)
    if (workspace && !paths.includes(workspace)) paths.push(workspace)
    return paths.sort()
  }, [workspace])

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-(--color-text-2)">Workspace</label>
      <div className="flex flex-wrap items-center gap-2">
          <div className="w-full min-w-0 sm:w-72 sm:shrink-0">
            <Dropdown
              value={workspace ?? ''}
              onValueChange={(v) => onChange(v || null)}
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
      </div>
      {workspaceError && workspaceErrorId && (
        <p id={workspaceErrorId} className="mt-1 text-xs text-(--color-error)">{workspaceError}</p>
      )}
      <p className="mt-1 text-xs text-(--color-text-muted)">
        Delivers to the coding agent for the selected workspace.{' '}
        <span className="text-(--color-text-subtle)">Workspaces come from saved coding workspaces.</span>
      </p>
    </div>
  )
}

// ── Panel root ──────────────────────────────────────────────────────────────

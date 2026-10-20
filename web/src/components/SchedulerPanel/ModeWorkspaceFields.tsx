import { useMemo } from 'react'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { loadWorkspaceEntries, workspaceLabel } from '@/utils/workspace'
import { FIELD_ERROR, FIELD_HINT, FIELD_LABEL } from './utils'

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
    const paths = loadWorkspaceEntries().map((entry) => entry.path)
    if (workspace && !paths.includes(workspace)) paths.push(workspace)
    return paths.sort()
  }, [workspace])

  return (
    <div>
      <label className={FIELD_LABEL}>Workspace</label>
      <div className="flex flex-wrap items-center gap-2">
          <div className="w-full min-w-0 @xl:w-72 @xl:shrink-0">
            <Dropdown
              value={workspace ?? ''}
              onValueChange={(v) => onChange(v || null)}
              trigger={workspace ? workspaceLabel(workspace) : 'Select a saved workspace…'}
              className="h-9 w-full max-w-full rounded-sm border-(--color-border) bg-(--bg-page) px-2.5 text-xs"
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
        <p id={workspaceErrorId} className={FIELD_ERROR}>{workspaceError}</p>
      )}
      <p className={FIELD_HINT}>The task runs as this workspace's coding agent. Pick from the folders in the sidebar.</p>
    </div>
  )
}

// ── Panel root ──────────────────────────────────────────────────────────────

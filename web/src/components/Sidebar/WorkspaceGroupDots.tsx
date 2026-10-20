import type { WorkspaceGroup } from '@/api/types'
import { groupColor } from './groupColor'

const MAX_DOTS = 3

/** "Groups: acme, shared" — the dots' label, also used in the row tooltip. */
export function workspaceGroupsLabel(groups: readonly WorkspaceGroup[]): string {
  return `Groups: ${groups.map((g) => g.name).join(', ')}`
}

/**
 * A repository's workspace groups as coloured dots after its name (three at
 * most, then "+N"). It sits inside the row's button, so it has no tooltip
 * of its own: the row's tooltip names the groups. Renders nothing when the
 * repository is in no group.
 */
export function WorkspaceGroupDots({ groups }: { groups: readonly WorkspaceGroup[] }) {
  if (groups.length === 0) return null
  const extra = groups.length - MAX_DOTS
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" role="img" aria-label={workspaceGroupsLabel(groups)} data-workspace-group-dots="">
      {groups.slice(0, MAX_DOTS).map((g) => (
        <span key={g.id} className="size-1.5 rounded-full" style={{ backgroundColor: groupColor(g.id) }} />
      ))}
      {extra > 0 && <span className="font-mono text-[11px] leading-none text-(--color-text-subtle)">+{extra}</span>}
    </span>
  )
}

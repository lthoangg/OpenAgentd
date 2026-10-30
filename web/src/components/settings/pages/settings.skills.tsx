import { Sparkles } from 'lucide-react'
import { useMemo } from 'react'

import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useSkillFilesQuery } from '@/queries'

interface SkillsListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

/** Where a skill file lives, in words. */
export function skillSourceLabel(source: string, builtIn: boolean): string {
  if (builtIn || source === 'builtin') return 'Built in'
  if (source === 'project-agents') return 'From project'
  if (source === 'global-agents') return 'From ~/.agents'
  return 'From config'
}

export function SkillsListPage({ selectedName, onSelect, onNew }: SkillsListPageProps) {
  const { data, isLoading, isError, error, refetch } = useSkillFilesQuery()

  const rows = useMemo<ListViewRow[]>(() => {
    const skills = data?.skills ?? []
    const flat = skills.filter((s) => !s.name.includes('/'))
    const nested = skills.filter((s) => s.name.includes('/'))
    const nestedByParent = new Map<string, typeof nested>()
    for (const skill of nested) {
      const [parent] = skill.name.split('/', 1)
      const group = nestedByParent.get(parent) ?? []
      group.push(skill)
      nestedByParent.set(parent, group)
    }

    const toRow = (s: (typeof skills)[number]): ListViewRow => {
      const slash = s.name.indexOf('/')
      return {
        key: s.name,
        active: selectedName === s.name,
        title: s.name,
        titleMono: true,
        badge: skillSourceLabel(s.source, s.built_in),
        description: [
          s.description || 'No description',
          !s.editable && !s.built_in ? 'Read-only' : null,
        ].filter(Boolean).join(' · '),
        descriptionLines: 2,
        metaChip: slash === -1 ? undefined : `Sub-skill of ${s.name.slice(0, slash)}`,
        invalidReason: !s.valid ? (s.error ?? 'Invalid configuration') : undefined,
        onClick: () => onSelect(s.name),
      }
    }

    const rows: ListViewRow[] = flat.map(toRow)
    for (const [parent, group] of [...nestedByParent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ key: `group:${parent}`, kind: 'group', title: `${parent} sub-skills` })
      rows.push(...group.sort((a, b) => a.name.localeCompare(b.name)).map(toRow))
    }
    return rows
  }, [data?.skills, selectedName, onSelect])

  return (
    <SettingsListView
      title="Skills"
      description="Instruction packs any agent can load on demand, from .agents/skills/ or your config folder."
      newLabel="New skill"
      onNew={onNew}
      filterPlaceholder="Filter skills…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      emptyTitle="No skills yet"
      emptyBody="A skill is a folder with a SKILL.md file. Agents load it when a task needs it."
      emptyIcon={Sparkles}
    />
  )
}

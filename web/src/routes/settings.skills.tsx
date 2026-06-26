import { Sparkles } from 'lucide-react'
import { useMemo } from 'react'

import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useSkillFilesQuery } from '@/queries'

interface SkillsListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

export function SkillsListPage({ selectedName, onSelect, onNew }: SkillsListPageProps) {
  const { data, isLoading, isError } = useSkillFilesQuery()

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
      const title = slash === -1 ? s.name : s.name.replace('/', ':')
      const badge = slash === -1 ? undefined : 'sub-skill'
      return {
        key: s.name,
        active: selectedName === s.name,
        title,
        badge,
        description: [
          s.description || 'No description',
          s.built_in ? 'Built-in' : null,
          !s.editable ? 'Read-only' : null,
          s.source !== 'global-openagentd' ? s.source : null,
        ].filter(Boolean).join(' · '),
        meta: slash === -1 ? undefined : s.name,
        invalidReason: !s.valid ? (s.error ?? 'Invalid configuration') : undefined,
        onClick: () => onSelect(s.name),
        trailing: (
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)"
            aria-hidden="true"
          >
            <Sparkles size={13} />
          </span>
        ),
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
      description="Reusable instruction packs available to any agent. Supports flat skills and one-level sub-skills (shown as parent:sub). Live in .openagentd/skills/."
      newLabel="New skill"
      onNew={onNew}
      filterPlaceholder="Filter skills…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      emptyTitle="No skills yet"
      emptyBody="Skills are reusable instruction modules agents load on demand via the skill tool."
    />
  )
}

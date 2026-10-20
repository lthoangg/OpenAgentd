/**
 * Workspace groups — the place to set up which workspaces may message each
 * other (`send_to_workspace`). Groups are named tags on repositories with an
 * optional brief their agents read; workspaces whose repositories share a
 * group may message each other, worktrees use their repository's groups, and
 * Chat reaches every workspace.
 *
 * Unlike the rest of the Automation page this is not a draft: every change is
 * its own request and saves at once, like the sidebar's group toggles.
 */
import { useId, useState, type FormEvent } from 'react'
import { Pencil, Plus, Tags, Trash2, X } from 'lucide-react'

import type { WorkspaceGroup } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { groupColor, groupColorHex, parseHexColor, suggestedGroupColor } from '@/components/Sidebar/groupColor'
import { ICON_SIZE, ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'
import {
  useCreateWorkspaceGroupMutation,
  useDeleteWorkspaceGroupMutation,
  useSetWorkspaceGroupsMutation,
  useUpdateWorkspaceGroupMutation,
  useWorkspaceGroups,
} from '@/queries/useWorkspaceGroups'

const NAME_MAX = 40
const BRIEF_MAX = 500
const BRIEF_PLACEHOLDER = 'Brief for agents, e.g. web = Next.js frontend, api = Rust backend'

/** The native picker drawn as a round swatch instead of the browser's button. */
const SWATCH_CLASS = cn(
  'size-5 shrink-0 cursor-pointer appearance-none rounded-full border-0 bg-transparent p-0',
  '[&::-webkit-color-swatch-wrapper]:p-0',
  '[&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border [&::-webkit-color-swatch]:border-(--color-border-strong)',
  '[&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border [&::-moz-color-swatch]:border-(--color-border-strong)',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
)

/** Row actions: revealed on hover or focus with a fine pointer, always shown on touch. */
const ROW_ACTIONS_CLASS = cn(
  'flex shrink-0 items-center gap-0.5 transition-opacity duration-(--motion-instant)',
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100',
)

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}

function workspaces(count: number): string {
  return count === 1 ? '1 workspace' : `${count} workspaces`
}

interface GroupFields {
  name: string
  brief: string
  /** `#rrggbb`. */
  color: string
}

/**
 * A colour as a swatch that opens the system picker beside a hex field. A
 * typed or pasted hex applies as soon as it parses, so the swatch follows
 * along; on blur the field settles to the `#rrggbb` it stands for.
 */
function ColorField({ value, onChange, onValidChange }: {
  /** Last valid colour, `#rrggbb`. */
  value: string
  onChange: (hex: string) => void
  onValidChange: (valid: boolean) => void
}) {
  const [text, setText] = useState(value)
  const errorId = useId()
  const invalid = parseHexColor(text) === null

  const setTyped = (next: string) => {
    setText(next)
    const hex = parseHexColor(next)
    onValidChange(hex !== null)
    if (hex) onChange(hex)
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'flex h-8 items-center gap-2 rounded-sm border bg-(--bg-input) pr-2.5 pl-1.5 transition-colors sm:w-32',
          'focus-within:border-(--focus-ring) focus-within:ring-2 focus-within:ring-(--focus-ring)/30',
          invalid ? 'border-(--color-error) ring-2 ring-(--color-error)/20' : 'border-(--color-border)',
        )}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Pick group colour"
          className={SWATCH_CLASS}
        />
        <input
          type="text"
          value={text}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => { if (!invalid) setText(value) }}
          aria-label="Group colour"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          maxLength={9}
          placeholder="#3b82f6"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-(--color-text) outline-none placeholder:text-(--color-text-muted)"
        />
      </div>
      {invalid && <p id={errorId} className="text-[11px] text-(--color-error)">Use a hex colour such as #3b82f6.</p>}
    </div>
  )
}

function GroupForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: GroupFields
  submitLabel: string
  busy: boolean
  /** `colorChanged` is false while the colour is still `initial.color`. */
  onSubmit: (value: GroupFields & { colorChanged: boolean }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [brief, setBrief] = useState(initial.brief)
  const [color, setColor] = useState(initial.color)
  const [colorValid, setColorValid] = useState(true)
  const canSubmit = !!name.trim() && colorValid && !busy
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit) onSubmit({ name: name.trim(), brief: brief.trim(), color, colorChanged: color !== initial.color })
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX}
          placeholder="Group name"
          aria-label="Group name"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="h-8 sm:flex-1"
        />
        <ColorField value={color} onChange={setColor} onValidChange={setColorValid} />
      </div>
      <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={BRIEF_MAX} placeholder={BRIEF_PLACEHOLDER} aria-label="Group brief" className="min-h-14" />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" disabled={!canSubmit}>{submitLabel}</Button>
      </div>
    </form>
  )
}

function GroupDot({ group }: { group: Pick<WorkspaceGroup, 'id' | 'color'> }) {
  return <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: groupColor(group) }} aria-hidden="true" />
}

export function WorkspaceGroupsSettings() {
  const { groups, groupIdsByRepo, repositories } = useWorkspaceGroups()
  const setGroups = useSetWorkspaceGroupsMutation()
  const createGroup = useCreateWorkspaceGroupMutation()
  const updateGroup = useUpdateWorkspaceGroupMutation()
  const deleteGroup = useDeleteWorkspaceGroupMutation()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }

  const tagsOf = (path: string) => groupIdsByRepo.get(path) ?? []
  const setMember = (group: WorkspaceGroup, path: string, member: boolean) => {
    const current = tagsOf(path)
    const next = member ? [...current, group.id] : current.filter((id) => id !== group.id)
    void run(() => setGroups.mutateAsync({ workspace: path, groupIds: next }))
  }
  const startEditing = (id: string) => {
    setConfirmDelete(null)
    setCreating(false)
    setEditing(id)
  }
  const startCreating = () => {
    setConfirmDelete(null)
    setEditing(null)
    setCreating(true)
  }

  return (
    <div className="space-y-3">
      <p className={TEXT.hint}>
        Repositories in the same group can message each other. Worktrees follow their
        repository, and Chat reaches every workspace. Changes save right away.
      </p>

      <div className="overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-page)">
        {groups.length === 0 && !creating && (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <span className="flex size-8 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-key)">
              <Tags size={ICON_SIZE} aria-hidden="true" className="text-(--color-text-muted)" />
            </span>
            <p className={TEXT.label}>No groups yet</p>
            <p className={cn('max-w-xs', TEXT.hint)}>Group related repositories so their agents can message each other.</p>
          </div>
        )}

        {groups.length > 0 && (
          <ul className="divide-y divide-(--color-border-subtle)" aria-label="Workspace groups">
            {groups.map((group) => {
              const members = repositories.filter((repo) => tagsOf(repo.path).includes(group.id))
              const others = repositories.filter((repo) => !tagsOf(repo.path).includes(group.id))

              if (editing === group.id) {
                return (
                  <li key={group.id} className="bg-(--bg-card) px-3 py-3">
                    <GroupForm
                      initial={{ name: group.name, brief: group.brief ?? '', color: groupColorHex(group) }}
                      submitLabel="Save"
                      busy={updateGroup.isPending}
                      onCancel={() => setEditing(null)}
                      onSubmit={({ name, brief, color, colorChanged }) => {
                        // An untouched colour stays as it is, so a derived
                        // colour keeps following the theme.
                        const update = { id: group.id, name, brief: brief || null, ...(colorChanged ? { color } : {}) }
                        void run(() => updateGroup.mutateAsync(update)).then((ok) => { if (ok) setEditing(null) })
                      }}
                    />
                  </li>
                )
              }

              return (
                <li key={group.id} className="group/row space-y-2 px-3 py-2.5 transition-colors duration-(--motion-instant) hover:bg-(--bg-card)">
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-5 items-center"><GroupDot group={group} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="flex h-5 min-w-0 items-baseline gap-2">
                        <span className={cn('truncate leading-5', TEXT.label)}>{group.name}</span>
                        <span className={cn('shrink-0', TEXT.subtle)}>{workspaces(members.length)}</span>
                      </p>
                      {group.brief && <p className={cn('break-words', TEXT.hint)}>{group.brief}</p>}
                    </div>
                    <div className={ROW_ACTIONS_CLASS}>
                      <Button type="button" size="icon-xs" variant="ghost" aria-label={`Edit group ${group.name}`} onClick={() => startEditing(group.id)}>
                        <Pencil size={ICON_SIZE_INLINE} aria-hidden="true" />
                      </Button>
                      <Button type="button" size="icon-xs" variant="ghost" aria-label={`Delete group ${group.name}`} onClick={() => setConfirmDelete(group.id)}>
                        <Trash2 size={ICON_SIZE_INLINE} aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  {confirmDelete === group.id ? (
                    <div className="ml-5 flex flex-wrap items-center gap-2 rounded-xs border border-(--color-error)/25 bg-(--color-error-subtle) py-1.5 pr-1.5 pl-2.5">
                      <p className="min-w-0 flex-1 text-xs text-(--color-text)">
                        Delete <span className="font-medium">{group.name}</span>?
                        {members.length > 0 && ` It is removed from ${workspaces(members.length)}.`}
                      </p>
                      <Button type="button" size="xs" onClick={() => setConfirmDelete(null)}>Keep</Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="danger"
                        disabled={deleteGroup.isPending}
                        onClick={() => { void run(() => deleteGroup.mutateAsync(group.id)).then(() => setConfirmDelete(null)) }}
                      >
                        Delete group
                      </Button>
                    </div>
                  ) : (
                    <div className="ml-5 flex flex-wrap items-center gap-1.5">
                      {members.length > 0 && (
                        <ul className="contents" aria-label={`Members of ${group.name}`}>
                          {members.map((repo) => (
                            <li key={repo.path} title={repo.path} className="inline-flex h-6 items-center gap-0.5 rounded-xs border border-(--color-border) bg-(--bg-card) pr-0.5 pl-2 text-xs text-(--color-text-2)">
                              <span className="max-w-40 truncate">{repo.name}</span>
                              <button
                                type="button"
                                aria-label={`Remove ${repo.name} from ${group.name}`}
                                disabled={setGroups.isPending}
                                onClick={() => setMember(group, repo.path, false)}
                                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none disabled:cursor-default disabled:opacity-50 pointer-coarse:size-6"
                              >
                                <X size={ICON_SIZE_INLINE} aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {others.length > 0 && (
                        <Dropdown
                          trigger={<><Plus size={ICON_SIZE_INLINE} aria-hidden="true" />Add workspace</>}
                          aria-label={`Add a workspace to ${group.name}`}
                          className="h-6 border-dashed px-2 text-xs text-(--color-text-muted)"
                          disabled={setGroups.isPending}
                        >
                          {others.map((repo) => (
                            <DropdownItem key={repo.path} title={repo.path} onSelect={() => setMember(group, repo.path, true)}>
                              {repo.name}
                            </DropdownItem>
                          ))}
                        </Dropdown>
                      )}
                      {members.length === 0 && others.length === 0 && (
                        <span className={TEXT.subtle}>Open a repository to add it here.</span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {creating ? (
          <div className={cn('bg-(--bg-card) px-3 py-3', groups.length > 0 && 'border-t border-(--color-border-subtle)')}>
            <GroupForm
              initial={{ name: '', brief: '', color: suggestedGroupColor(groups.length) }}
              submitLabel="Create group"
              busy={createGroup.isPending}
              onCancel={() => setCreating(false)}
              onSubmit={({ name, brief, color }) => {
                void run(() => createGroup.mutateAsync({ name, brief: brief || null, color })).then((ok) => { if (ok) setCreating(false) })
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={startCreating}
            className={cn(
              'flex h-9 w-full cursor-pointer items-center gap-2 border-t border-(--color-border-subtle) px-3 text-left text-xs font-medium text-(--color-text-muted)',
              'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none focus-visible:ring-inset pointer-coarse:h-11',
            )}
          >
            <Plus size={ICON_SIZE} aria-hidden="true" />
            New group
          </button>
        )}
      </div>

      {error && <p role="alert" className="text-[11px] text-(--color-error)">{error}</p>}
    </div>
  )
}

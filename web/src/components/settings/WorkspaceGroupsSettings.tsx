/**
 * Workspace groups — the place to set up which workspaces may message each
 * other (the `workspace` tool). Groups are named tags on repositories with an
 * optional brief their agents read; workspaces whose repositories share a
 * group may message each other, worktrees use their repository's groups, and
 * Chat reaches every workspace.
 *
 * Unlike the messages switch beside it on the Workspaces page, this is not a
 * draft: every change is its own request and saves at once, like the
 * sidebar's group toggles. Rendered in the flush body of a SettingsSection,
 * which carries the explanation.
 */
import { useId, useState, type FormEvent } from 'react'
import { Pencil, Plus, Tags, Trash2, X } from 'lucide-react'

import type { WorkspaceGroup } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { groupColor, groupColorHex, parseHexColor, suggestedGroupColor } from '@/components/Sidebar/groupColor'
import { Field } from '@/components/ui/field'
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
const BRIEF_PLACEHOLDER = 'For example: web = Next.js frontend, api = Rust backend'

/** The native picker drawn as a round swatch instead of the browser's button. */
const SWATCH_CLASS = cn(
  'size-5 shrink-0 cursor-pointer appearance-none rounded-full pointer-coarse:size-9 border-0 bg-transparent p-0',
  '[&::-webkit-color-swatch-wrapper]:p-0',
  '[&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border [&::-webkit-color-swatch]:border-(--color-border-strong)',
  '[&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border [&::-moz-color-swatch]:border-(--color-border-strong)',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
)

/** Row actions stay visible (they are the only way to edit); muted until the row is hovered. */
const ROW_ACTION_CLASS = cn(
  'text-(--color-text-subtle) transition-colors duration-(--motion-instant)',
  'group-hover/row:text-(--color-text-muted) hover:text-(--color-text)',
)

/** Indent that lines content up with the group name, past the colour dot. */
const TEXT_COLUMN = 'pl-[22px]'

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
          'flex h-9 items-center gap-2 rounded-sm border bg-(--bg-input) pr-2.5 pl-2 transition-colors sm:w-36',
          'focus-within:border-(--focus-ring) focus-within:ring-2 focus-within:ring-(--focus-ring)/30',
          invalid ? 'border-(--color-error) ring-2 ring-(--color-error)/20' : 'border-(--color-border)',
        )}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Pick group color"
          className={SWATCH_CLASS}
        />
        <input
          type="text"
          value={text}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => { if (!invalid) setText(value) }}
          aria-label="Group color"
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
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-x-4 gap-y-5 sm:grid-cols-[1fr_auto]">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX}
            placeholder="Group name"
            aria-label="Group name"
            autoComplete="off"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck={false}
            autoFocus
            className="h-9"
          />
        </Field>
        <Field label="Color">
          <ColorField value={color} onChange={setColor} onValidChange={setColorValid} />
        </Field>
      </div>
      <Field label="Notes for agents" hint="Agents in this group read this to learn what each workspace is for.">
        <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={BRIEF_MAX} placeholder={BRIEF_PLACEHOLDER} aria-label="Notes for agents" className="min-h-20" />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
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
    <div>
      {groups.length === 0 && !creating && (
        <div className="px-4 py-8">
          <EmptyState
            fill={false}
            icon={Tags}
            title="No groups yet"
            body="Group related repositories so their agents can message each other."
          />
        </div>
      )}

      {groups.length > 0 && (
        <ul className="divide-y divide-(--color-border-subtle)" aria-label="Workspace groups">
          {groups.map((group) => {
            const members = repositories.filter((repo) => tagsOf(repo.path).includes(group.id))
            const others = repositories.filter((repo) => !tagsOf(repo.path).includes(group.id))

            if (editing === group.id) {
              return (
                <li key={group.id} className="bg-(--bg-card) px-4 py-4">
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
              <li key={group.id} className="group/row space-y-3 px-4 py-3.5 transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/15">
                <div className="flex items-start gap-3">
                  <span className="flex h-5 items-center"><GroupDot group={group} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="flex h-5 min-w-0 items-baseline gap-2">
                      <span className={cn('truncate leading-5', TEXT.label)}>{group.name}</span>
                      <span className={cn('shrink-0', TEXT.subtle)}>{workspaces(members.length)}</span>
                    </p>
                    {group.brief && <p className={cn('mt-1 break-words', TEXT.hint)}>{group.brief}</p>}
                  </div>
                  <div className="-my-1.5 flex shrink-0 items-center gap-0.5">
                    <Button type="button" size="icon-sm" variant="ghost" className={ROW_ACTION_CLASS} aria-label={`Edit group ${group.name}`} onClick={() => startEditing(group.id)}>
                      <Pencil size={ICON_SIZE_INLINE} aria-hidden="true" />
                    </Button>
                    <Button type="button" size="icon-sm" variant="ghost" className={ROW_ACTION_CLASS} aria-label={`Delete group ${group.name}`} onClick={() => setConfirmDelete(group.id)}>
                      <Trash2 size={ICON_SIZE_INLINE} aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {confirmDelete === group.id ? (
                  <div className={cn(TEXT_COLUMN, 'max-sm:pl-0')}>
                    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-(--color-error)/25 bg-(--color-error-subtle) px-3 py-2.5">
                      <p className="min-w-0 flex-1 text-xs leading-relaxed text-(--color-text)">
                        Delete <span className="font-medium">{group.name}</span>?
                        {members.length > 0 && ` It is removed from ${workspaces(members.length)}.`}
                      </p>
                      <Button type="button" size="sm" onClick={() => setConfirmDelete(null)}>Keep</Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={deleteGroup.isPending}
                        onClick={() => { void run(() => deleteGroup.mutateAsync(group.id)).then(() => setConfirmDelete(null)) }}
                      >
                        Delete group
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className={cn(TEXT_COLUMN, 'flex flex-wrap items-center gap-1.5')}>
                    {members.length > 0 && (
                      <ul className="contents" aria-label={`Members of ${group.name}`}>
                        {members.map((repo) => (
                          <li key={repo.path} title={repo.path} className="inline-flex h-7 items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-card) pr-1 pl-2.5 text-xs text-(--color-text-2) pointer-coarse:h-9 pointer-coarse:pr-0">
                            <span className="max-w-40 truncate">{repo.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${repo.name} from ${group.name}`}
                              onClick={() => setMember(group, repo.path, false)}
                              className="inline-flex size-5 cursor-pointer items-center justify-center rounded-xs text-(--color-text-subtle) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none disabled:cursor-default disabled:opacity-50 pointer-coarse:size-9"
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
                        className="h-7 border-dashed px-2.5 text-xs text-(--color-text-muted)"
                      >
                        {others.map((repo) => (
                          <DropdownItem key={repo.path} title={repo.path} onSelect={() => setMember(group, repo.path, true)}>
                            {repo.name}
                          </DropdownItem>
                        ))}
                      </Dropdown>
                    )}
                    {members.length === 0 && others.length === 0 && (
                      <span className={TEXT.subtle}>Open another workspace to add it here.</span>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {creating ? (
        <div className={cn('bg-(--bg-card) px-4 py-4', groups.length > 0 && 'border-t border-(--color-border-subtle)')}>
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
            'flex h-9 w-full cursor-pointer items-center gap-2 border-t border-(--color-border-subtle) px-4 text-left text-xs font-medium text-(--color-text-muted) md:h-10',
            'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
            'focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none focus-visible:ring-inset',
          )}
        >
          <Plus size={ICON_SIZE} aria-hidden="true" />
          New group
        </button>
      )}

      {error && (
        <p role="alert" className="border-t border-(--color-border-subtle) px-4 py-3 text-[11px] leading-relaxed text-(--color-error)">
          {error}
        </p>
      )}
    </div>
  )
}

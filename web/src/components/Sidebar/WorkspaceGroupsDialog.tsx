import { useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { WorkspaceGroup } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  useCreateWorkspaceGroupMutation,
  useDeleteWorkspaceGroupMutation,
  useSetWorkspaceGroupsMutation,
  useUpdateWorkspaceGroupMutation,
  useWorkspaceGroups,
} from '@/queries/useWorkspaceGroups'
import { groupColor } from './groupColor'

const NAME_MAX = 40
const BRIEF_MAX = 500
const BRIEF_PLACEHOLDER = 'Brief for agents, e.g. web = Next.js frontend, api = Rust backend'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}

function GroupForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; brief: string }
  submitLabel: string
  busy: boolean
  onSubmit: (value: { name: string; brief: string }) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [brief, setBrief] = useState(initial.brief)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) onSubmit({ name: name.trim(), brief: brief.trim() })
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} placeholder="Group name" aria-label="Group name" autoComplete="off" spellCheck={false} />
      <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={BRIEF_MAX} placeholder={BRIEF_PLACEHOLDER} aria-label="Group brief" className="min-h-14" />
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>{submitLabel}</Button>
      </div>
    </form>
  )
}

/**
 * Tag one repository with workspace groups, and create, edit or delete
 * groups. Workspaces whose repositories share a group may message each other;
 * Chat reaches every workspace. Checkbox changes save at once.
 */
export function WorkspaceGroupsDialog({
  workspace,
  label,
  onClose,
}: {
  /** Repository path, or null when closed. */
  workspace: string | null
  label: string
  onClose: () => void
}) {
  const { groups, groupIdsByRepo } = useWorkspaceGroups()
  const setGroups = useSetWorkspaceGroupsMutation()
  const createGroup = useCreateWorkspaceGroupMutation()
  const updateGroup = useUpdateWorkspaceGroupMutation()
  const deleteGroup = useDeleteWorkspaceGroupMutation()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const memberIds = workspace ? (groupIdsByRepo.get(workspace) ?? []) : []
  const memberCount = (id: string) => [...groupIdsByRepo.values()].filter((ids) => ids.includes(id)).length

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

  const toggle = (group: WorkspaceGroup, checked: boolean) => {
    if (!workspace) return
    const next = checked ? [...memberIds, group.id] : memberIds.filter((id) => id !== group.id)
    void run(() => setGroups.mutateAsync({ workspace, groupIds: next }))
  }

  const close = () => {
    setEditing(null)
    setConfirmDelete(null)
    setCreating(false)
    setError(null)
    onClose()
  }

  return (
    <Dialog open={workspace !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent size="md" padding="compact" className="gap-3">
        <DialogHeader className="gap-1 pr-8">
          <DialogTitle>Groups for {label}</DialogTitle>
          <DialogDescription className="text-xs leading-4">
            Workspaces that share a group can message each other. Chat can message every workspace.
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="Workspace groups">
          {groups.length === 0 && !creating && (
            <li className="px-1 py-2 text-xs text-(--color-text-subtle)">No groups yet. Create one to connect related workspaces.</li>
          )}
          {groups.map((group) => (
            <li key={group.id} className="rounded-sm px-1 py-1 hover:bg-(--bg-key)/40">
              {editing === group.id ? (
                <GroupForm
                  initial={{ name: group.name, brief: group.brief ?? '' }}
                  submitLabel="Save"
                  busy={updateGroup.isPending}
                  onCancel={() => setEditing(null)}
                  onSubmit={({ name, brief }) => {
                    void run(() => updateGroup.mutateAsync({ id: group.id, name, brief: brief || null })).then((ok) => { if (ok) setEditing(null) })
                  }}
                />
              ) : (
                <div className="flex items-start gap-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={memberIds.includes(group.id)}
                      disabled={setGroups.isPending}
                      onCheckedChange={(checked) => toggle(group, checked)}
                      aria-label={`In group ${group.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(group.id) }} aria-hidden="true" />
                        <span className="truncate font-medium text-(--color-text)">{group.name}</span>
                        <span className="shrink-0 text-(--color-text-subtle)">· {memberCount(group.id)}</span>
                      </span>
                      {group.brief && <span className="mt-0.5 block truncate text-(--color-text-muted)">{group.brief}</span>}
                    </span>
                  </label>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Edit group ${group.name}`} onClick={() => { setConfirmDelete(null); setEditing(group.id) }}>
                    <Pencil size={12} aria-hidden="true" />
                  </Button>
                  {confirmDelete === group.id ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="danger"
                      disabled={deleteGroup.isPending}
                      onClick={() => { void run(() => deleteGroup.mutateAsync(group.id)).then(() => setConfirmDelete(null)) }}
                    >
                      Delete group
                    </Button>
                  ) : (
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Delete group ${group.name}`} onClick={() => setConfirmDelete(group.id)}>
                      <Trash2 size={12} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        {creating ? (
          <GroupForm
            initial={{ name: '', brief: '' }}
            submitLabel="Create and add"
            busy={createGroup.isPending}
            onCancel={() => setCreating(false)}
            onSubmit={({ name, brief }) => {
              void run(async () => {
                const group = await createGroup.mutateAsync({ name, brief: brief || null })
                // Created from a repository's dialog: tag that repository.
                if (workspace) await setGroups.mutateAsync({ workspace, groupIds: [...memberIds, group.id] })
              }).then((ok) => { if (ok) setCreating(false) })
            }}
          />
        ) : (
          <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { setEditing(null); setCreating(true) }}>
            <Plus size={12} aria-hidden="true" />
            New group
          </Button>
        )}

        {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}

        <DialogFooter className="p-3">
          <Button type="button" variant="primary" onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

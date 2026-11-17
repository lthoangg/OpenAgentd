/**
 * Settings → Secrets: the keys the user gave the agent. The agent runs
 * commands with them without seeing them, and a connector can use one as
 * `${NAME}`. A name may hold several values, each for some projects (folders)
 * or for every project. A value is write-only: it goes up when it is saved
 * and is never shown again, only replaced.
 *
 * Typed values live in component state of a dialog that unmounts when it
 * closes, and nowhere else: not storage, not the query cache, not logs.
 */
import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react'

import { getCodingWorkspaceTree } from '@/api/client'
import type { SecretEntry } from '@/api/question-types'
import {
  useDeleteSecretMutation,
  useSaveSecretMutation,
  useSecretsQuery,
} from '@/queries'
import { queryKeys } from '@/queries/keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { TEXT } from '@/components/ui/panel-tokens'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { errorMessage } from '@/utils/errors'

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/
const ALL = '*'

/** What the row says about where a value is used. */
function usedIn(entry: SecretEntry): string {
  return entry.all ? 'All projects' : entry.projects.map((p) => p.name).join(', ')
}

/** The same, for a sentence: "for client-a". */
function usedInSentence(entry: SecretEntry): string {
  if (entry.all) return 'for every project'
  return entry.projects.length ? `for ${usedIn(entry)}` : ''
}

function sourceLabel(source: SecretEntry['source']): string | null {
  if (source === 'chat') return 'from chat'
  if (source === 'settings') return 'in Settings'
  return null
}

function addedLine(entry: SecretEntry): string {
  const when = entry.updated ? new Date(entry.updated) : null
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString() : null
  return [date ? `Updated ${date}` : null, sourceLabel(entry.source)].filter(Boolean).join(' · ')
}

/** The folders of the workspaces OpenAgentd knows, to suggest while typing a path. */
function useWorkspacePaths(): string[] {
  const { data } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: 30_000,
    select: (tree) => tree.repositories.map((repo) => repo.path),
  })
  return data ?? []
}

export function SecretsSettingsPage() {
  const { data, isLoading, error } = useSecretsQuery()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SecretEntry | null>(null)
  const [deleting, setDeleting] = useState<SecretEntry | null>(null)

  const secrets = [...(data?.secrets ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  const addButton = (
    <Button size="sm" variant="default" className="min-h-9 md:min-h-0" onClick={() => setAdding(true)}>
      <Plus size={12} aria-hidden="true" />
      Add secret
    </Button>
  )

  return (
    <SettingsPage
      title="Secrets"
      loading={isLoading}
      error={error}
      description="Keys you gave the agent. It uses them in its commands without seeing them; connectors can use one as ${NAME}. Values are never shown again — only replaced."
    >
      <PanelSection title="Saved keys" actions={secrets.length > 0 ? addButton : null} flush={secrets.length > 0}>
        {secrets.length === 0 ? (
          <EmptyState
            fill={false}
            className="py-4"
            icon={KeyRound}
            title="No secrets yet"
            body="When a task needs an API key, the agent asks for it in the chat. You can also add one here."
            action={addButton}
          />
        ) : (
          secrets.map((entry) => (
            <SecretRow key={`${entry.name}:${entry.id}`} entry={entry} onEdit={setEditing} onDelete={setDeleting} />
          ))
        )}
      </PanelSection>

      {adding && <AddSecretDialog onClose={() => setAdding(false)} />}
      {editing && <EditSecretDialog entry={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteSecretDialog entry={deleting} onClose={() => setDeleting(null)} />}
    </SettingsPage>
  )
}

// ─── One saved value ────────────────────────────────────────────────────────

function SecretRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: SecretEntry
  onEdit: (entry: SecretEntry) => void
  onDelete: (entry: SecretEntry) => void
}) {
  const missing = entry.all ? [] : entry.projects.filter((p) => p.missing)
  const meta = addedLine(entry)
  return (
    <PanelRow
      label={<span className="font-mono">{entry.name}</span>}
      description={
        <>
          <span>
            Used in: {entry.all ? 'All projects' : entry.projects.map((p) => p.name).join(', ') || 'No project'}
            {missing.map((p) => (
              <span
                key={p.key}
                className="ml-1.5 rounded-xs bg-(--bg-key) px-1 text-[0.6875rem] text-(--color-text-muted)"
              >
                {p.name}: folder missing
              </span>
            ))}
          </span>
          {meta && <span className="block">{meta}</span>}
        </>
      }
    >
      <Button
        size="sm"
        variant="default"
        className="min-h-9 md:min-h-0"
        onClick={() => onEdit(entry)}
        aria-label={`Edit ${entry.name} ${usedInSentence(entry)}`.trim()}
      >
        <Pencil size={12} aria-hidden="true" />
        Edit
      </Button>
      <Button
        size="sm"
        variant="default"
        className="min-h-9 text-(--color-text-muted) hover:text-(--color-error) md:min-h-0"
        onClick={() => onDelete(entry)}
        aria-label={`Delete ${entry.name} ${usedInSentence(entry)}`.trim()}
      >
        <Trash2 size={12} aria-hidden="true" />
        Delete
      </Button>
    </PanelRow>
  )
}

// ─── Delete ─────────────────────────────────────────────────────────────────

function DeleteSecretDialog({ entry, onClose }: { entry: SecretEntry; onClose: () => void }) {
  const del = useDeleteSecretMutation()
  const [error, setError] = useState<string | null>(null)
  const scope = entry.all ? 'every project' : entry.projects.map((p) => p.name).join(', ')

  const confirm = async () => {
    setError(null)
    try {
      await del.mutateAsync({ name: entry.name, id: entry.id })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !del.isPending) onClose() }}>
      <DialogContent showCloseButton={false} alert>
        <DialogHeader>
          <DialogTitle>{`Delete ${entry.name}${scope ? ` for ${scope}` : ''}?`}</DialogTitle>
          <DialogDescription>
            Commands that use it will stop working.
            {error && <span role="alert" className="mt-1 block text-(--color-error)">{error}</span>}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose} disabled={del.isPending}>Cancel</Button>
          <Button type="button" variant="danger" onClick={() => { void confirm() }} disabled={del.isPending}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Form pieces ────────────────────────────────────────────────────────────

/** A masked field for a value, with a Show / Hide toggle. */
function SecretValueField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={TEXT.label}>{label}</label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 font-mono"
        />
        <Button
          type="button"
          size="sm"
          variant="default"
          className="min-h-9 shrink-0 md:min-h-0"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
    </div>
  )
}

interface ScopeState {
  all: boolean
  keys: string[]
  pending: string
}

/** The folders to save: the chips, plus a path typed but not yet added. */
function scopeProjects(scope: ScopeState): string[] {
  if (scope.all) return [ALL]
  const pending = scope.pending.trim()
  return pending && !scope.keys.includes(pending) ? [...scope.keys, pending] : scope.keys
}

/** "Used in": every project, or these folders as removable chips. */
function ScopeField({
  idPrefix,
  scope,
  onChange,
  labels,
}: {
  idPrefix: string
  scope: ScopeState
  onChange: (next: ScopeState) => void
  /** Folder names for keys the server named. */
  labels: Record<string, string>
}) {
  const workspaces = useWorkspacePaths()
  const listId = `${idPrefix}-folders`
  const pathId = `${idPrefix}-path`
  const suggestions = workspaces.filter((path) => !scope.keys.includes(path))

  const addPending = () => {
    const path = scope.pending.trim()
    if (!path) return
    onChange({ ...scope, keys: scope.keys.includes(path) ? scope.keys : [...scope.keys, path], pending: '' })
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className={`${TEXT.label} mb-2`}>Used in</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${idPrefix}-scope`}
          checked={scope.all}
          onChange={() => onChange({ ...scope, all: true })}
        />
        All projects
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${idPrefix}-scope`}
          checked={!scope.all}
          onChange={() => onChange({ ...scope, all: false })}
        />
        These projects
      </label>
      {!scope.all && (
        <div className="flex min-w-0 flex-col gap-2 pl-6">
          {scope.keys.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {scope.keys.map((key) => (
                <li
                  key={key}
                  className="flex max-w-full items-center gap-1 rounded-sm border border-(--color-border) bg-(--bg-key) py-0.5 pr-0.5 pl-2 text-xs"
                >
                  <span className="min-w-0 truncate" title={key}>{labels[key] ?? key}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${labels[key] ?? key}`}
                    className="rounded-xs p-1 text-(--color-text-muted) hover:text-(--color-text)"
                    onClick={() => onChange({ ...scope, keys: scope.keys.filter((k) => k !== key) })}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Input
              id={pathId}
              aria-label="Folder path"
              list={listId}
              spellCheck={false}
              placeholder="/path/to/project"
              value={scope.pending}
              onChange={(e) => onChange({ ...scope, pending: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addPending()
                }
              }}
              className="h-9 font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="default"
              className="min-h-9 shrink-0 md:min-h-0"
              disabled={!scope.pending.trim()}
              onClick={addPending}
            >
              Add folder
            </Button>
          </div>
          <datalist id={listId}>
            {suggestions.map((path) => <option key={path} value={path} />)}
          </datalist>
        </div>
      )}
    </fieldset>
  )
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? <p role="alert" className="text-xs text-(--color-error)">{message}</p> : null
}

// ─── Add ────────────────────────────────────────────────────────────────────

function AddSecretDialog({ onClose }: { onClose: () => void }) {
  const save = useSaveSecretMutation()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<ScopeState>({ all: true, keys: [], pending: '' })
  const [error, setError] = useState<string | null>(null)

  const nameInvalid = name !== '' && !NAME_PATTERN.test(name)
  const projects = scopeProjects(scope)
  const canSave = NAME_PATTERN.test(name) && value !== '' && projects.length > 0 && !save.isPending

  const close = () => {
    setValue('')
    save.reset()
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setError(null)
    try {
      await save.mutateAsync({ name, body: { value, projects, source: 'settings' } })
      close()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !save.isPending) close() }}>
      <DialogContent>
        <form onSubmit={(e) => { void submit(e) }} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add secret</DialogTitle>
            <DialogDescription>The agent can use it in commands without seeing it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor="secret-name" className={TEXT.label}>Name</label>
            <Input
              id="secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="STRIPE_SECRET_KEY"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={nameInvalid}
              aria-describedby="secret-name-hint"
              className="h-9 font-mono"
            />
            <p
              id="secret-name-hint"
              className={nameInvalid ? 'text-xs text-(--color-error)' : 'text-xs text-(--color-text-muted)'}
            >
              {nameInvalid
                ? 'Use capital letters, digits and underscores, and do not start with a digit.'
                : 'UPPER_SNAKE_CASE, as your code reads it'}
            </p>
          </div>
          <SecretValueField id="secret-value" label="Value" value={value} onChange={setValue} />
          <ScopeField idPrefix="secret-add" scope={scope} onChange={setScope} labels={{}} />
          <ErrorLine message={error} />
          <DialogFooter>
            <Button type="button" variant="default" onClick={close} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canSave}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit ───────────────────────────────────────────────────────────────────

function EditSecretDialog({ entry, onClose }: { entry: SecretEntry; onClose: () => void }) {
  const save = useSaveSecretMutation()
  const initialKeys = entry.all ? [] : entry.projects.map((p) => p.key)
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<ScopeState>({ all: entry.all, keys: initialKeys, pending: '' })
  const [error, setError] = useState<string | null>(null)
  const labels = Object.fromEntries(entry.projects.map((p) => [p.key, p.name]))

  const projects = scopeProjects(scope)
  const before = entry.all ? [ALL] : initialKeys
  const scopeChanged = projects.length !== before.length || projects.some((p) => !before.includes(p))
  const canSave = (value !== '' || scopeChanged) && projects.length > 0 && !save.isPending

  const close = () => {
    setValue('')
    save.reset()
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    setError(null)
    const body: { id: string; value?: string; projects?: string[] } = { id: entry.id }
    if (value !== '') body.value = value
    if (scopeChanged) body.projects = projects
    try {
      await save.mutateAsync({ name: entry.name, body })
      close()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !save.isPending) close() }}>
      <DialogContent>
        <form onSubmit={(e) => { void submit(e) }} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{`Edit ${entry.name}`}</DialogTitle>
            <DialogDescription>
              The saved value is never shown. Leave the new value empty to keep it.
            </DialogDescription>
          </DialogHeader>
          <SecretValueField
            id="secret-edit-value"
            label="New value"
            value={value}
            onChange={setValue}
            placeholder="Keep the saved value"
          />
          <ScopeField idPrefix="secret-edit" scope={scope} onChange={setScope} labels={labels} />
          <ErrorLine message={error} />
          <DialogFooter>
            <Button type="button" variant="default" onClick={close} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canSave}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

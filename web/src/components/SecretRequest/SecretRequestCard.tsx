/**
 * SecretRequestCard — the form the user answers the ``secret`` tool with.
 *
 * One masked field per key the agent asked for. Values live only in this
 * component's state: no draft cache, no store, no log. On Save each value
 * goes to ``PUT /api/secrets`` and the card is answered with names only, so
 * the agent learns which keys it can use but never what they are.
 *
 * Per key:
 * - ``new``: paste it (an optional key may stay empty).
 * - ``elsewhere``: a value is saved for other projects. Use one of those, or
 *   enter a different value for this project. Neither is picked at first, so
 *   another project's account is never used by default.
 * - ``replace``: the agent says the saved value was rejected. Paste the new
 *   one, for everywhere it is used or only this project.
 * New values are for this project unless the user picks "All projects".
 */
import { useId, useState, type ReactNode } from 'react'
import { ExternalLink, KeyRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import type { PendingQuestion, SecretAnswer, SecretKeyAnswer, SecretRequestKey, SecretValueRef } from '@/api/question-types'
import type { SecretSave } from '@/components/AskUser/useQuestionResolver'

/** Shorter values cannot be hidden in output (``appv3_core::secret_mask::MIN_MASKED_CHARS``). */
const MIN_MASKED_CHARS = 8

type Choice = { kind: 'reuse'; id: string } | { kind: 'different' } | { kind: 'everywhere' } | { kind: 'here' } | null

interface Row {
  value: string
  show: boolean
  choice: Choice
}

/** Where a saved value is used, for a label: "client-a", "all projects". */
export function usedIn(v: SecretValueRef): string {
  if (v.all) return 'all projects'
  return v.projects.map((p) => p.name).join(', ') || 'no project'
}

/** A replaced value other projects use too, so the user picks where the new one applies. */
function sharedValue(k: SecretRequestKey): boolean {
  const v = k.values[0]
  return Boolean(v && (v.all || v.projects.length > 1))
}

function initialChoice(k: SecretRequestKey): Choice {
  if (k.state !== 'replace') return null
  // Used here only: replacing it changes nothing elsewhere, so no choice.
  return sharedValue(k) ? { kind: 'everywhere' } : { kind: 'here' }
}

/** Whether a key's row needs a pasted value with its current choice. */
function needsValue(k: SecretRequestKey, row: Row): boolean {
  if (k.state === 'new' || k.state === 'replace') return true
  return k.state === 'elsewhere' && row.choice?.kind === 'different'
}

/** Whether a key's row is answered well enough to save. */
function rowReady(k: SecretRequestKey, row: Row): boolean {
  if (k.state === 'elsewhere' && row.choice === null) return k.optional
  if (needsValue(k, row)) return row.value.trim() !== '' || (k.optional && k.state === 'new')
  return true
}

/** The saves, the answer and the transcript lines for the card's rows. */
export function planSecretAnswer(
  keys: SecretRequestKey[],
  rows: Record<string, Row>,
  project: string,
  allProjects: boolean,
  replace: boolean,
): { saves: SecretSave[]; answer: SecretAnswer; summary: string[] } {
  const saves: SecretSave[] = []
  const answers: SecretKeyAnswer[] = []
  const provided: string[] = []
  const reused: string[] = []
  const skipped: string[] = []
  const scope = allProjects ? ['*'] : [project]
  for (const k of keys) {
    if (k.state === 'available') continue
    const row = rows[k.name]
    const value = row.value.includes('\n') ? row.value : row.value.trim()
    if (row.choice?.kind === 'reuse') {
      answers.push({ name: k.name, action: 'reuse', id: row.choice.id })
      reused.push(k.name)
    } else if (needsValue(k, row) && value) {
      if (k.state === 'replace' && row.choice?.kind === 'everywhere') saves.push({ name: k.name, body: { value, id: k.values[0]?.id } })
      else if (k.state === 'replace') saves.push({ name: k.name, body: { value, projects: [project] } })
      else saves.push({ name: k.name, body: { value, projects: scope } })
      answers.push({ name: k.name, action: 'provided' })
      provided.push(k.name)
    } else {
      answers.push({ name: k.name, action: 'skip' })
      skipped.push(k.name)
    }
  }
  const summary: string[] = []
  if (provided.length) summary.push(`${replace ? 'Replaced' : 'Provided'}: ${provided.join(', ')}`)
  if (reused.length) summary.push(`Using saved: ${reused.join(', ')}`)
  if (skipped.length) summary.push(`Skipped: ${skipped.join(', ')}`)
  return { saves, answer: { keys: answers }, summary }
}

interface SecretRequestCardProps {
  question: PendingQuestion
  submitting: boolean
  error: string | null
  onSave: (saves: SecretSave[], answer: SecretAnswer, summary: string[]) => void
  className?: string
}

export function SecretRequestCard({ question, submitting, error, onSave, className }: SecretRequestCardProps) {
  const card = question.secret
  const keys = (card?.keys ?? []).filter((k) => k.state !== 'available')
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(keys.map((k) => [k.name, { value: '', show: false, choice: initialChoice(k) }])),
  )
  const [scope, setScope] = useState<'project' | 'all'>('project')
  if (!card) return null
  const update = (name: string, patch: Partial<Row>) => setRows((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }))
  const asksNewValues = keys.some((k) => k.state === 'new' || k.state === 'elsewhere')
  const ready = keys.every((k) => rowReady(k, rows[k.name])) && keys.some((k) => {
    const row = rows[k.name]
    return row.choice?.kind === 'reuse' || row.value.trim() !== ''
  })
  const count = keys.filter((k) => rows[k.name].choice?.kind === 'reuse' || rows[k.name].value.trim() !== '').length

  const save = () => {
    const plan = planSecretAnswer(card.keys, rows, card.project, scope === 'all', card.replace)
    onSave(plan.saves, plan.answer, plan.summary)
  }
  const decline = () => onSave([], { declined: true }, ['Declined'])

  return (
    <div data-secret-card="" className={cn('flex flex-col gap-3 px-3 pt-1 pb-3', className)}>
      {card.reason ? <p className="text-sm leading-relaxed text-(--color-text) [overflow-wrap:anywhere]">{card.reason}</p> : null}
      {keys.map((k) => (
        <KeyRow key={k.name} k={k} row={rows[k.name]} project={card.project_name} onChange={(patch) => update(k.name, patch)} />
      ))}
      {asksNewValues ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--color-border-subtle) pt-2.5">
          <span className="text-xs text-(--color-text-2)">New values are for</span>
          <SegmentedControl
            label="New values are for"
            size="sm"
            value={scope}
            onChange={setScope}
            options={[{ value: 'project', label: card.project_name ? `This project (${card.project_name})` : 'This project' }, { value: 'all', label: 'All projects' }]}
          />
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-(--color-error)">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--color-border-subtle) pt-2.5">
        <span className="text-xs leading-relaxed text-(--color-text-muted)">The agent can use these in commands it runs, but never sees the values.</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" disabled={submitting} onClick={decline}>Decline</Button>
          <Button size="sm" variant="primary" disabled={submitting || !ready} onClick={save}>
            {submitting ? 'Saving…' : count > 1 ? `Save ${count}` : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function KeyRow({ k, row, project, onChange }: { k: SecretRequestKey; row: Row; project: string; onChange: (patch: Partial<Row>) => void }) {
  const groupName = useId()
  const note =
    k.state === 'elsewhere' ? `a value is saved for ${k.values.map(usedIn).join('; ')}`
      : k.state === 'replace' ? `used in ${k.values[0] ? usedIn(k.values[0]) : project}`
      : k.optional ? 'optional' : null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-mono text-xs font-medium text-(--color-text)">{k.name}</span>
        <span className="flex items-baseline gap-2 text-xs text-(--color-text-muted)">
          {note}
          {k.help_url ? (
            <button type="button" className="inline-flex items-center gap-1 underline decoration-(--color-border) underline-offset-2 hover:text-(--color-text)" onClick={() => { void openExternalUrl(k.help_url!) }}>
              Where to get it <ExternalLink size={12} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
      {k.state === 'elsewhere' ? (
        <div role="radiogroup" aria-label={`${k.name}: which value`} className="flex flex-col gap-1">
          {k.values.map((v) => (
            <Radio key={v.id} name={groupName} checked={row.choice?.kind === 'reuse' && row.choice.id === v.id} onChange={() => onChange({ choice: { kind: 'reuse', id: v.id }, value: '' })}>
              Use the one saved for {usedIn(v)} <span className="text-(--color-text-muted)">· {project || 'this project'} is added to it</span>
            </Radio>
          ))}
          <Radio name={groupName} checked={row.choice?.kind === 'different'} onChange={() => onChange({ choice: { kind: 'different' } })}>
            Enter a different value for this project
          </Radio>
        </div>
      ) : null}
      {needsValue(k, row) ? <SecretField k={k} row={row} onChange={onChange} /> : null}
      {k.state === 'replace' && sharedValue(k) ? (
        <div role="radiogroup" aria-label={`${k.name}: where to use the new value`} className="flex flex-col gap-1">
          <Radio name={groupName} checked={row.choice?.kind === 'everywhere'} onChange={() => onChange({ choice: { kind: 'everywhere' } })}>
            Replace it everywhere it is used ({k.values[0] ? usedIn(k.values[0]) : ''})
          </Radio>
          <Radio name={groupName} checked={row.choice?.kind === 'here'} onChange={() => onChange({ choice: { kind: 'here' } })}>
            Use the new value only in this project
          </Radio>
        </div>
      ) : null}
    </div>
  )
}

function SecretField({ k, row, onChange }: { k: SecretRequestKey; row: Row; onChange: (patch: Partial<Row>) => void }) {
  const label = `${k.name} value`
  const placeholder = k.state === 'replace' ? 'Paste the new value' : `Paste ${k.name}`
  const short = row.value.trim() !== '' && row.value.trim().length < MIN_MASKED_CHARS
  const common = {
    'aria-label': label,
    placeholder,
    value: row.value,
    autoComplete: 'off',
    spellCheck: false,
    autoCapitalize: 'off',
    autoCorrect: 'off',
    'data-1p-ignore': '',
    'data-lpignore': 'true',
    className: 'min-w-0 flex-1 bg-transparent font-mono text-xs text-(--color-text) outline-none placeholder:font-sans placeholder:text-(--color-text-muted)',
  } as const
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2 rounded-md border border-(--color-border) bg-(--bg-input) px-2.5 py-1.5 focus-within:border-(--color-text-subtle)">
        {k.multiline ? (
          <textarea
            {...common}
            rows={4}
            // Masked like a password field until shown (WebKit / Chromium).
            style={{ WebkitTextSecurity: row.show ? 'none' : 'disc' } as React.CSSProperties}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        ) : (
          <input {...common} type={row.show ? 'text' : 'password'} onChange={(e) => onChange({ value: e.target.value })} />
        )}
        <button type="button" className="shrink-0 text-xs text-(--color-text-muted) hover:text-(--color-text)" aria-pressed={row.show} onClick={() => onChange({ show: !row.show })}>
          {row.show ? 'Hide' : 'Show'}
        </button>
      </div>
      {short ? <span className="text-xs text-(--color-text-muted)">Values under {MIN_MASKED_CHARS} characters can't be hidden if they show up in output.</span> : null}
    </div>
  )
}

function Radio({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-(--color-text)">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5 accent-(--color-accent)" />
      <span>{children}</span>
    </label>
  )
}

/** The transcript's label icon. */
export const SecretIcon = KeyRound

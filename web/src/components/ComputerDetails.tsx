/**
 * Details of one computer or device of the account: what its list row no
 * longer carries (system, key, role, address), and Rename.
 *
 * A name is what the computer calls itself (`/api/server/name`: its host
 * name until someone names it), so it is changed on the computer, through
 * the app's connection or the account's link to it, and every device of the
 * account then shows it. The
 * name is text from a computer: drawn as plain text, and the key stays in
 * full beside it here and wherever a device is approved or removed.
 */
import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TEXT } from '@/components/ui/panel-tokens'
import { deviceKindLabel } from '@/lib/app-backend'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/utils/errors'

/** The longest name a computer keeps (the server's limit). */
export const COMPUTER_NAME_MAX = 40

export interface ComputerFact {
  label: string
  value: string
  /** A key or an address. */
  mono?: boolean
}

/** System, key and role of a device of the account. */
export function deviceFacts(device: {
  kind: string | null | undefined
  fingerprint: string
  signer: boolean
  server: boolean
  client: boolean
}): ComputerFact[] {
  const system = deviceKindLabel(device.kind)
  const uses = device.server && device.client ? 'Server and client' : device.server ? 'Server' : 'Client'
  return [
    ...(system ? [{ label: 'System', value: system }] : []),
    { label: 'Key', value: device.fingerprint, mono: true },
    { label: 'Role', value: device.signer ? `${uses} · approves devices` : uses },
  ]
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 py-1.5">
      <dt className={cn('w-20 shrink-0', TEXT.hint)}>{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
    </div>
  )
}

export function ComputerDetailsDialog({ open, onOpenChange, title, name, facts, rename = null, renameHint }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the row calls it. */
  title: string
  /**
   * The computer's name, where the title is something else ("Built-in
   * server"); `null` when the app does not know it. Defaults to the title.
   */
  name?: string | null
  facts: ComputerFact[]
  /** Rename the computer itself. `name` is its current name. */
  rename?: { name: string; save: (name: string) => Promise<void> } | null
  /** Shown where Rename would be, when it cannot be renamed from here. */
  renameHint?: string
}) {
  const inputId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (next: boolean) => {
    if (!next) { setDraft(null); setError(null) }
    onOpenChange(next)
  }
  const save = async () => {
    if (!rename || draft === null || saving) return
    setSaving(true)
    setError(null)
    try {
      await rename.save(draft.trim())
      setDraft(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const shownName = rename?.name || (name === undefined ? title : name)
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="sm">
        <DialogHeader>
          {/* Plain text, one direction: a name is whatever its computer says. */}
          <DialogTitle className="truncate pr-8"><bdi>{title}</bdi></DialogTitle>
        </DialogHeader>
        <dl className="mt-3 divide-y divide-(--color-border-subtle)">
          {shownName || rename ? <Fact label="Name">
            {draft === null ? (
              <>
                <span className="min-w-0 flex-1 truncate text-sm text-(--color-text)"><bdi>{shownName}</bdi></span>
                {rename ? (
                  <Button type="button" variant="subtle" size="sm" onClick={() => setDraft(rename.name)}>Rename</Button>
                ) : null}
              </>
            ) : (
              <>
                <label htmlFor={inputId} className="sr-only">Name</label>
                <Input
                  id={inputId}
                  value={draft}
                  maxLength={COMPUTER_NAME_MAX}
                  autoFocus
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={saving}
                  className="min-w-0 flex-1"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void save() }
                    // Only the edit, not the dialog around it.
                    if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); setError(null) }
                  }}
                />
                <Button type="button" variant="primary" size="sm" disabled={saving} onClick={() => void save()}>Save</Button>
                <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setDraft(null); setError(null) }}>Cancel</Button>
              </>
            )}
          </Fact> : null}
          {facts.map((fact) => (
            <Fact key={fact.label} label={fact.label}>
              <span className={cn('min-w-0 break-all text-sm text-(--color-text)', fact.mono && 'font-mono text-xs select-text')}>{fact.value}</span>
            </Fact>
          ))}
        </dl>
        {draft !== null ? <p className={cn('mt-2', TEXT.hint)}>Leave it empty to use the computer’s own name.</p> : null}
        {!rename && renameHint ? <p className={cn('mt-2', TEXT.hint)}>{renameHint}</p> : null}
        {error ? <Callout tone="error" role="alert" className="mt-3">{error}</Callout> : null}
      </DialogContent>
    </Dialog>
  )
}

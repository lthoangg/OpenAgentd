/**
 * Joining an account with the invitation link a phone shows: the desktop's
 * default way in (a computer cannot scan), and the phone's paste fallback.
 * The link works like a password, so the field hides it and nothing here
 * keeps it after the submit.
 */
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/** What a pasted invitation link starts with (spec section 4.3). */
export const INVITE_PREFIX = 'agentd://invite?'

export function JoinWithLink({ onJoin, busy, hint }: { onJoin: (link: string) => void; busy: boolean; hint: string }) {
  const [link, setLink] = useState('')
  const trimmed = link.trim()
  const looksRight = trimmed.startsWith(INVITE_PREFIX)
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!looksRight) return
        onJoin(trimmed)
        setLink('')
      }}
    >
      <p>{hint}</p>
      <Field label="Invitation link" htmlFor="invite-link">
        <Input
          id="invite-link"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`${INVITE_PREFIX}…`}
          value={link}
          onChange={(event) => setLink(event.target.value)}
          className="h-9 font-mono"
        />
      </Field>
      {trimmed !== '' && !looksRight && (
        <p role="alert" className="text-xs text-(--color-error)">That is not an invitation link. Copy it again from your phone.</p>
      )}
      <Button type="submit" variant="primary" size="sm" disabled={busy || !looksRight}>Join</Button>
    </form>
  )
}

/** While a phone decides: what to compare there. */
export function InvitedCopy({ label }: { label: string }) {
  return (
    <>
      <p>
        On your phone, check that it shows this device:{' '}
        <strong className="font-mono text-(--color-text)">{label}</strong>. Then tap Add.
      </p>
      <p className="italic">Waiting for your phone…</p>
    </>
  )
}

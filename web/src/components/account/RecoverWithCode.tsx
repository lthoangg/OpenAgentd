/**
 * Getting back into an account whose only approving device is lost (spec
 * 4.4): the person types the recovery code they saved when the account was
 * set up, then signs in in the browser. This device then becomes the
 * account's only device and approves the next ones; every other device is
 * signed out. The code stays the same afterwards (the account's recovery
 * key cannot change), so the same saved code keeps working.
 *
 * The code works like a password: the field hides it, nothing keeps it
 * after the submit, and it is checked here only for its shape.
 */
import { useState } from 'react'

import { Body } from '@/components/settings/pages/account-copy'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

/** Characters in a recovery code, without its dashes (13 groups of 4). */
const CODE_CHARS = 52

/** Whether `text` has the shape of a recovery code: 52 letters A–Z and digits 2–7, dashes and spaces aside. */
export function looksLikeRecoveryCode(text: string): boolean {
  const clean = text.replace(/[\s-]+/g, '').toUpperCase()
  return clean.length === CODE_CHARS && /^[A-Z2-7]+$/.test(clean)
}

export function RecoverWithCode({ busy, onRecover, onCancel, device }: {
  busy: boolean
  onRecover: (code: string) => void
  onCancel?: () => void
  /** "computer" or "phone". */
  device: string
}) {
  const [code, setCode] = useState('')
  const trimmed = code.trim()
  const ok = looksLikeRecoveryCode(trimmed)
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ok) return
        onRecover(trimmed)
        setCode('')
      }}
    >
      <p className="font-medium text-(--color-text)">Lost your phone? Use your recovery code.</p>
      <p>
        Type the recovery code you saved when you set up your account, then sign in in the browser. This {device} then
        approves new devices, and your other devices are signed out: sign them in again from here.
      </p>
      <Field label="Recovery code" htmlFor="recovery-code">
        <Input
          id="recovery-code"
          type="password"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-…"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="h-9 font-mono"
        />
      </Field>
      {trimmed !== '' && !ok && (
        <p role="alert" className="text-xs text-(--color-error)">A recovery code is 13 groups of 4 letters and digits.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy || !ok}>Continue</Button>
        {onCancel && <Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}

/** After a recovery, until the person reads it. */
export function RecoveredNote({ device, onDone, busy }: { device: string; onDone: () => void; busy: boolean }) {
  return (
    <Callout tone="info" role="status" title="You're back in.">
      <Body>
        <p>
          This {device} now approves new devices. Your other devices were signed out: sign them in again, and approve
          them here.
        </p>
        <p>Your recovery code stays the same. Keep it somewhere safe.</p>
        <div><Button variant="primary" size="sm" disabled={busy} onClick={onDone}>OK</Button></div>
      </Body>
    </Callout>
  )
}

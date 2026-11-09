/**
 * The recovery code of a new account (spec 4.1), on whichever device creates
 * it: shown once, then two groups typed back. The code is never selectable
 * and has no Copy button: the clipboard is readable by other apps.
 */
import { useState } from 'react'

import { Body } from '@/components/settings/pages/account-copy'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelSection } from '@/components/ui/panel-section'

/** Recovery codes are dash-separated groups; five to a line. */
const GROUPS_PER_LINE = 5

function lines(code: string): string[] {
  const groups = code.split('-')
  const out: string[] = []
  for (let i = 0; i < groups.length; i += GROUPS_PER_LINE) out.push(groups.slice(i, i + GROUPS_PER_LINE).join(' '))
  return out
}

/**
 * The recovery code, once, then two groups typed back. The code is never
 * selectable and has no Copy button: the clipboard is readable by other apps.
 */
export function RecoveryStep({
  code,
  check,
  onCancel,
  busy,
  confirm,
}: {
  code: string
  check: [number, number]
  onCancel: () => void
  busy: boolean
  /** Sends the two groups; its error stays on this step. */
  confirm: { mutate: (groups: { first: string; second: string }) => void; error: Error | null; isPending: boolean }
}) {
  const [step, setStep] = useState<'show' | 'check'>('show')
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const typing = { autoComplete: 'off', autoCapitalize: 'characters', spellCheck: false, className: 'h-9 font-mono' } as const

  if (step === 'show') {
    return (
      <PanelSection title="Recovery code">
        <Body>
          <p className="font-medium text-(--color-text)">Save your recovery code.</p>
          <p>
            If you lose every device that can approve others, this code is the only way back into your account.
            OpenAgentd can&apos;t recover it for you.
          </p>
          <div
            data-sensitive=""
            className="select-none space-y-1 rounded-sm border border-(--color-border) bg-(--bg-key) p-3 font-mono text-sm text-(--color-text) [-webkit-touch-callout:none] [-webkit-user-select:none]"
            onCopy={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {lines(code).map((line) => <div key={line}>{line}</div>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => setStep('check')}>I saved it</Button>
            <Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
          </div>
        </Body>
      </PanelSection>
    )
  }
  return (
    <PanelSection title="Check your recovery code">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          confirm.mutate({ first: first.trim(), second: second.trim() })
        }}
      >
        <Field label={`Type group ${check[0]}`} htmlFor="recovery-first">
          <Input id="recovery-first" value={first} onChange={(event) => setFirst(event.target.value)} {...typing} />
        </Field>
        <Field label={`Type group ${check[1]}`} htmlFor="recovery-second">
          <Input id="recovery-second" value={second} onChange={(event) => setSecond(event.target.value)} {...typing} />
        </Field>
        {confirm.error && <p role="alert" className="text-xs text-(--color-error)">{confirm.error.message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={confirm.isPending || !first.trim() || !second.trim()}>
            Confirm
          </Button>
          <Button size="sm" disabled={confirm.isPending} onClick={() => setStep('show')}>Show the code again</Button>
          <Button size="sm" disabled={busy || confirm.isPending} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </PanelSection>
  )
}

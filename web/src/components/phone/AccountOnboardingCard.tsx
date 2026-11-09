/**
 * The one place a phone guest is told an account exists: a dismissible card
 * under the Servers list. It never blocks anything. "Not now" is remembered
 * for good; Settings → Account stays reachable.
 */
import { useState } from 'react'

import { OfferCopy } from '@/components/settings/pages/account-copy'
import { Button } from '@/components/ui/button'
import { usePhoneCloudStatus, usePhoneSignIn } from '@/queries/phone-cloud'

const DISMISSED_KEY = 'openagentd.cloud.onboardingDismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function AccountOnboardingCard({ onSignedIn }: { onSignedIn: () => void }) {
  const status = usePhoneCloudStatus().data
  const signIn = usePhoneSignIn()
  const [dismissed, setDismissed] = useState(readDismissed)
  if (dismissed || status?.state !== 'guest' || !status.supported) return null

  const notNow = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Storage unavailable: it hides for this run.
    }
    setDismissed(true)
  }
  return (
    <section aria-label="Account" className="space-y-3 rounded-sm border border-(--color-border) bg-(--bg-card) p-4 text-xs leading-relaxed text-(--color-text-2)">
      <OfferCopy />
      {signIn.error && <p role="alert" className="text-(--color-error)">{signIn.error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={signIn.isPending} onClick={() => signIn.mutate(undefined, { onSuccess: onSignedIn })}>
          Sign in
        </Button>
        <Button variant="ghost" size="sm" onClick={notNow}>Not now</Button>
      </div>
    </section>
  )
}

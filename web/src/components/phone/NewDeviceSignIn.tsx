/**
 * How a new iPhone or iPad gets into the person's account: it shows a QR
 * code, and their other phone scans it (scan to add, spec 4.3.1). The QR
 * code is the first thing on the screen; signing in with Google (the same
 * sign-in code, in the browser) and the recovery code are two small links
 * under it.
 *
 * The code is asked for as soon as this shows, and again whenever it runs
 * out, while the app is in front: the person never taps for a new one. A
 * code that cannot be had (no network, too many requests) shows a short
 * note and **Try again** instead, so nothing loops.
 *
 * After the scan: "Tap Add on your iPhone", then the three numbers. One
 * pick only; the shell leaves the account on a wrong one, on Cancel and
 * after two minutes.
 *
 * Plain words only on this path (DESIGN.md, "Plain words"): no "cloud",
 * no "fingerprint"; the device ID shows only on the Google way, where the
 * sign-in page shows it too.
 */
import { useEffect, useRef, useState } from 'react'

import type { PhoneCloudStatus, PhoneNotice } from '@/api/phone-cloud'
import { ConnectQrCode } from '@/components/ConnectQrCode'
import { RecoverWithCode } from '@/components/account/RecoverWithCode'
import { Body, displayUrl, noticeCopy, type NoticeCopy } from '@/components/settings/pages/remote-copy'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { nearbyPhoneName, otherPhoneName, thisDeviceName } from '@/lib/device-words'
import { openExternalUrl } from '@/lib/open-external'
import { usePhoneCancel, usePhonePickNumber, usePhoneRecover, usePhoneSignIn } from '@/queries/phone-cloud'

/** The states this screen draws; the rest belong to the Account page. */
export function isNewDeviceStep(status: PhoneCloudStatus | undefined): boolean {
  if (!status) return false
  if (status.state === 'guest') return status.supported
  if (status.state === 'signing_in') return !status.recovering
  return status.state === 'scanned' || status.state === 'confirming'
}

/** Notices after which a new code is not asked for by itself: it would fail the same way. */
const NO_AUTO_CODE = new Set<PhoneNotice>(['unreachable', 'rate_limited', 'failed', 'account_unavailable', 'too_many_pending', 'device_limit'])

/** The last time a sign-in ended: shown above the new code, not in place of it. */
export function notAddedCopy(notice: PhoneNotice, phone: string, retryAfter?: number | null): NoticeCopy | null {
  switch (notice) {
    case 'wrong_number': return { body: `Not added. That wasn't the number on ${phone}. Scan the new code to try again.`, tone: 'warning' }
    case 'join_ended': return { body: 'Not added. Scan the new code to try again.' }
    case 'commit_mismatch':
    case 'confirm_mismatch': return { body: 'Not added. Try again.' }
    // The code was renewed by itself: nothing to say.
    case 'expired': return null
    default: return noticeCopy(notice, retryAfter)
  }
}

export const CODE_UNAVAILABLE = "Can't show a code right now. Check your connection."

type View = 'scan' | 'google' | 'recovery'

export function NewDeviceSignIn({ status, initialView = 'scan' }: {
  status: PhoneCloudStatus
  /** `recovery`: open on the recovery code (from a waiting step's "Lost your phone?"). */
  initialView?: 'scan' | 'recovery'
}) {
  const self = thisDeviceName()
  const thisOne = self === 'phone' ? 'this phone' : `this ${self}`
  const phone = otherPhoneName(self)
  const signIn = usePhoneSignIn()
  const cancel = usePhoneCancel()
  const recover = usePhoneRecover()
  const pick = usePhonePickNumber()
  const notice = status.state === 'guest' ? status.notice : null
  const [view, setView] = useState<View>(notice === 'wrong_recovery_code' ? 'recovery' : initialView)
  const [shown, setShown] = useState<PhoneNotice | null>(notice)
  const [seen, setSeen] = useState<PhoneNotice | null>(notice)
  if (notice !== seen) {
    setSeen(notice)
    if (notice) setShown(notice)
    if (notice === 'wrong_recovery_code') setView('recovery')
  }
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const guest = status.state === 'guest'
  const blocked = guest && notice !== null && NO_AUTO_CODE.has(notice)
  const { mutate: start, isPending: starting, isError: startFailed } = signIn
  // A code as soon as the screen shows, and a new one when it runs out:
  // once each time the phone is a guest again, so an answer that leaves it
  // a guest (an older shell) cannot loop.
  const asked = useRef(false)
  useEffect(() => {
    if (!guest) {
      asked.current = false
      return
    }
    if (asked.current || view === 'recovery' || !visible || blocked || starting || startFailed) return
    asked.current = true
    start()
  }, [guest, view, visible, blocked, starting, startFailed, start])

  const busy = starting || cancel.isPending || recover.isPending || pick.isPending
  const retry = () => {
    signIn.reset()
    asked.current = true
    start()
  }
  const failure = signIn.error ?? cancel.error ?? recover.error ?? pick.error
  const ended = shown ? notAddedCopy(shown, phone, status.state === 'guest' ? status.retry_after : null) : null

  if (status.state === 'scanned') {
    return (
      <Body>
        <p className="text-base font-medium text-(--color-text)">Tap Add on {phone}.</p>
        <p>Then pick the number it shows here.</p>
        <div><Button disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button></div>
      </Body>
    )
  }

  if (status.state === 'confirming') {
    return (
      <div data-number-pick="" className="space-y-4">
        <h2 className="text-xl font-semibold text-(--color-text)">Which number is on {phone}?</h2>
        <div className="flex gap-3">
          {status.choices.map((n) => (
            <Button
              key={n}
              size="lg"
              className="h-20 flex-1 font-mono text-3xl font-bold tabular-nums"
              disabled={busy}
              onClick={() => pick.mutate(n)}
            >
              {n}
            </Button>
          ))}
        </div>
        <p className="text-xs text-(--color-text-muted)">No number on {phone}? Tap Cancel.</p>
        {failure && <Callout tone="error" role="alert">{failure.message}</Callout>}
        <div><Button variant="ghost" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button></div>
      </div>
    )
  }

  const signingIn = status.state === 'signing_in' ? status : null

  if (view === 'recovery') {
    return (
      <Body>
        {failure && <Callout tone="error" role="alert">{failure.message}</Callout>}
        {shown === 'wrong_recovery_code' && ended && <Callout tone="warning" role="status" title={ended.title}>{ended.body}</Callout>}
        <RecoverWithCode
          device={self === 'phone' ? 'phone' : self}
          busy={busy}
          // A recovery is its own sign-in: the one showing the QR code stops first.
          onRecover={(code) => { void cancel.mutateAsync().then(() => recover.mutate(code)).catch(() => undefined) }}
          onCancel={() => setView('scan')}
        />
      </Body>
    )
  }

  if (view === 'google') {
    return (
      <Body>
        <p className="text-base font-medium text-(--color-text)">Sign in with Google</p>
        {signingIn ? (
          <>
            <p>
              Open <strong className="text-(--color-text)">{displayUrl(signingIn.url)}</strong>, sign in, and enter{' '}
              <strong className="font-mono text-(--color-text)">{signingIn.user_code}</strong>.
            </p>
            <p>
              Check that the page shows the same device ID:{' '}
              <strong className="font-mono text-(--color-text)">{signingIn.fingerprint}</strong>
            </p>
            <div className="flex flex-wrap gap-2">
              {signingIn.url.startsWith('https://') && (
                <Button variant="primary" onClick={() => { void openExternalUrl(signingIn.url) }}>Open sign-in page</Button>
              )}
              <Button variant="ghost" onClick={() => setView('scan')}>Back</Button>
            </div>
          </>
        ) : (
          <CodeUnavailable blocked={blocked || startFailed} busy={busy} onRetry={retry} />
        )}
      </Body>
    )
  }

  return (
    <div data-new-device="" className="flex flex-col items-center space-y-4 text-center">
      {ended && <Callout tone={ended.tone ?? 'info'} title={ended.title} role="status" className="w-full text-left">{ended.body}</Callout>}
      <p className="text-base text-(--color-text-2)">
        Open OpenAgentd on {phone} and tap <strong className="text-(--color-text)">Scan</strong>.
      </p>
      {signingIn?.add_link ? (
        <div className="rounded-lg border border-(--color-border) p-3">
          <ConnectQrCode value={signingIn.add_link} size={208} label={`QR code to add ${thisOne}`} />
        </div>
      ) : signingIn ? (
        // An older shell has no scan code: the Google way is the way.
        <p className="text-xs text-(--color-text-muted)">Update OpenAgentd on {thisOne} to add it with a scan.</p>
      ) : (
        <CodeUnavailable blocked={blocked || startFailed} busy={busy} onRetry={retry} />
      )}
      {failure && <Callout tone="error" role="alert" className="w-full text-left">{failure.message}</Callout>}
      <div className="flex flex-col items-center gap-1 pt-2">
        <Button variant="link" size="sm" disabled={!signingIn && !guest} onClick={() => setView('google')}>
          No {nearbyPhoneName()} nearby? Sign in with Google
        </Button>
        <Button variant="link" size="sm" onClick={() => setView('recovery')}>
          Lost your phone? Use your recovery code
        </Button>
      </div>
    </div>
  )
}

/** No code yet: getting one, or why not and Try again. */
function CodeUnavailable({ blocked, busy, onRetry }: { blocked: boolean; busy: boolean; onRetry: () => void }) {
  if (!blocked) {
    return <div role="status" className="grid h-58 w-58 place-items-center rounded-lg border border-(--color-border) text-xs text-(--color-text-muted)">Getting a code…</div>
  }
  return (
    <div role="status" className="space-y-3">
      <p className="text-xs text-(--color-text-2)">{CODE_UNAVAILABLE}</p>
      <Button variant="primary" disabled={busy} onClick={onRetry}>Retry</Button>
    </div>
  )
}

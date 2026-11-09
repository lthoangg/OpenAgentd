/**
 * AddDeviceSheet — adding a device to the account from the phone (an
 * approver). The invitation QR code comes first; the 6-digit code is the
 * fallback (spec section 4.3).
 *
 * The invitation is a secret until it is used, so:
 * - the QR code exists only while this sheet is open: closing it, leaving
 *   it (unmount), or the app going to the background cancels the
 *   invitation, unless the device was added;
 * - the link is shown only after a step that says it works like a password;
 * - a device whose proof checks out is shown with its kind and fingerprint,
 *   and added only when the person taps Add (Face ID, natively);
 * - when two devices prove the secret, the shell adds nobody and cancels
 *   the invitation; this sheet says so and offers a new one.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import {
  deviceLabel,
  phoneCloudApproveReject,
  phoneCloudInviteCancel,
  phoneCloudInvitePoll,
  phoneCloudInviteStart,
  type InviteCandidate,
  type InviteView,
} from '@/api/phone-cloud'
import { ConnectQrCode } from '@/components/ConnectQrCode'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePhoneInviteAdd } from '@/queries/phone-cloud'

/** How often the sheet looks for a device that claimed the invitation. */
export const INVITE_POLL_MS = 2000

type Step = 'qr' | 'link-warning' | 'link' | 'code'
type Outcome = 'compromised' | 'ended' | null

export function AddDeviceSheet({ onClose }: { onClose: () => void }) {
  const [invite, setInvite] = useState<InviteView | null>(null)
  const [step, setStep] = useState<Step>('qr')
  const [candidate, setCandidate] = useState<InviteCandidate | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const add = usePhoneInviteAdd()
  const added = useRef(false)
  const started = useRef(false)
  /** Cancelled already (closed, or left for good). */
  const cancelled = useRef(false)
  /** The sheet is gone: an invitation that arrives late is cancelled. */
  const gone = useRef(false)
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelInvite = useCallback(() => {
    if (added.current || cancelled.current) return
    cancelled.current = true
    void phoneCloudInviteCancel().catch(() => undefined)
  }, [])

  const start = useCallback(() => {
    setInvite(null)
    setCandidate(null)
    setOutcome(null)
    setError(null)
    setStep('qr')
    cancelled.current = false
    phoneCloudInviteStart().then((v) => {
      if (gone.current) {
        cancelled.current = false
        cancelInvite()
      } else setInvite(v)
    }, (e: Error) => setError(e.message))
  }, [cancelInvite])

  // Once per sheet: a strict-mode remount must not open a second invitation.
  useEffect(() => {
    if (started.current) return
    started.current = true
    start()
  }, [start])

  // Leaving the sheet cancels the invitation. The cancel waits a tick, so
  // strict mode's unmount-and-remount (which keeps the sheet) clears it
  // instead of cancelling the fresh invitation.
  useEffect(() => {
    if (leaving.current) clearTimeout(leaving.current)
    leaving.current = null
    gone.current = false
    return () => {
      leaving.current = setTimeout(() => {
        gone.current = true
        cancelInvite()
      }, 0)
    }
  }, [cancelInvite])

  // Look for a claim while an invitation is open.
  useEffect(() => {
    if (!invite || outcome || add.isPending) return
    let stopped = false
    const look = () => {
      phoneCloudInvitePoll().then((poll) => {
        if (stopped) return
        if (poll.state === 'candidate') setCandidate(poll.candidate)
        else if (poll.state === 'waiting') setCandidate(null)
        else {
          setCandidate(null)
          setInvite(null)
          setOutcome(poll.state)
        }
      }, (e: Error) => { if (!stopped) setError(e.message) })
    }
    look()
    const timer = setInterval(look, INVITE_POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [invite, outcome, add.isPending])

  const close = useCallback(() => {
    cancelInvite()
    onClose()
  }, [onClose, cancelInvite])

  // Out of sight is out of use: the code must not outlive the screen.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') close() }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [close])

  const confirmAdd = (c: InviteCandidate) => {
    add.mutate(c.enrollment_id, {
      onSuccess: () => { added.current = true; onClose() },
      // The shell re-checks every candidate; it may have cancelled.
      onError: () => { setCandidate(null) },
    })
  }

  const notThisOne = (c: InviteCandidate) => {
    setCandidate(null)
    setError(null)
    void phoneCloudApproveReject(c.enrollment_id).catch((e: Error) => setError(e.message))
  }

  const copyLink = (link: string) => {
    void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => undefined)
  }

  let body: ReactNode
  let footer: ReactNode
  if (outcome) {
    body = (
      <Callout tone={outcome === 'compromised' ? 'warning' : 'info'} role="alert">
        {outcome === 'compromised'
          ? 'Someone else has this invitation, so nobody was added and it was cancelled. Show a new one, and keep it to the device you are adding.'
          : 'This invitation expired.'}
      </Callout>
    )
    footer = (
      <>
        <Button variant="default" onClick={close}>Close</Button>
        <Button variant="primary" onClick={start}>New invitation</Button>
      </>
    )
  } else if (candidate) {
    body = (
      <div className="space-y-3">
        <p>A device wants to join:</p>
        <p className="font-mono text-sm text-(--color-text)" data-testid="invite-candidate">
          {deviceLabel({ kind: candidate.kind, fingerprint: candidate.fingerprint })}
        </p>
        <p>Add it only if the new device shows the same.</p>
      </div>
    )
    footer = (
      <>
        <Button variant="default" disabled={add.isPending} onClick={() => notThisOne(candidate)}>Not this one</Button>
        <Button variant="primary" disabled={add.isPending} onClick={() => confirmAdd(candidate)}>Add</Button>
      </>
    )
  } else if (step === 'code') {
    body = (
      <p>
        On the new device, choose <strong className="text-(--color-text)">Sign in with a code instead</strong>.
        Its request shows up under Pending approvals; review it there and compare the 6-digit code on both screens.
      </p>
    )
    footer = <Button variant="primary" onClick={close}>Done</Button>
  } else if (step === 'link-warning') {
    body = (
      <Callout tone="warning" role="status" title="This link works like a password">
        Send it only to the device you are adding. Anyone who has it before then can ask to join your account.
      </Callout>
    )
    footer = (
      <>
        <Button variant="default" onClick={() => setStep('qr')}>Back</Button>
        <Button variant="primary" onClick={() => setStep('link')}>Show link</Button>
      </>
    )
  } else if (step === 'link' && invite) {
    body = (
      <div className="space-y-3">
        <p>On the new device, choose Join with an invitation and paste this link.</p>
        <p data-sensitive="" className="break-all rounded-sm border border-(--color-border) bg-(--bg-key) p-2 font-mono text-xs text-(--color-text)">
          {invite.link}
        </p>
      </div>
    )
    footer = (
      <>
        <Button variant="default" onClick={() => setStep('qr')}>Show QR code</Button>
        <Button variant="primary" onClick={() => copyLink(invite.link)}>{copied ? 'Copied' : 'Copy link'}</Button>
      </>
    )
  } else {
    body = invite ? (
      <div className="space-y-3">
        <div className="flex justify-center">
          <ConnectQrCode value={invite.link} size={200} label="Invitation QR code" />
        </div>
        <p>
          On the new device, open OpenAgentd, choose Join with an invitation, and scan this code. It works for
          10 minutes, and only while this screen is open.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setStep('link-warning')}>Can&apos;t scan? Use a link</Button>
          <Button size="sm" onClick={() => setStep('code')}>Use a 6-digit code instead</Button>
        </div>
      </div>
    ) : (
      !error && (
        <p role="status" className="flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          Preparing an invitation…
        </p>
      )
    )
    footer = <Button variant="default" onClick={close}>Cancel</Button>
  }

  const failure = error ?? add.error?.message ?? null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add a device</DialogTitle>
          <DialogDescription>Your phone checks every device before it joins.</DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3 text-xs leading-relaxed text-(--color-text-2)">
          {body}
          {failure && <Callout tone="error" role="alert">{failure}</Callout>}
        </div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

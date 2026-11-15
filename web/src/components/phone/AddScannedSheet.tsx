/**
 * The phone adds the device it scanned, then shows its number (spec 4.3.1):
 * a new iPhone or iPad, or a computer. A default add is the device and
 * **Add**: its device ID, the uses it asked for and whether it can add
 * devices are under **Details**. Face ID happens natively on Add; then the
 * big 2-digit number to tap on the new device.
 *
 * The account's kind is all the phone knows of the device before it is
 * added, and `ios` covers an iPhone and an iPad alike, so a new one is an
 * "iPhone or iPad" here (`kindNoun`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Roles } from '@/api/cloud'
import { deviceLabel, phoneCloudInviteCancel, phoneCloudInvitePoll, type InviteCandidate } from '@/api/phone-cloud'
import { RolesChoice } from '@/components/account/RolesChoice'
import { CODE_TIMED_OUT, CAN_ADD_DEVICES } from '@/components/settings/pages/account-copy'
import { INVITE_POLL_MS } from '@/components/account/InviteSheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isPhoneKind, kindNoun } from '@/lib/device-words'
import { usePhoneAddScanned, usePhoneScannedAdd } from '@/queries/phone-cloud'

/** The words of the sheet for a device of `kind` (null until it claims). */
export function scannedCopy(kind: string | null | undefined) {
  const noun = kindNoun(kind)
  const phone = isPhoneKind(kind)
  return {
    title: `Add this ${noun}?`,
    body: phone ? 'It can use your computers.' : kind ? 'You can use it from this phone.' : 'It can use your computers, or be used from this phone.',
    waiting: `Waiting for the ${noun}…`,
    number: phone ? `Tap this number on the ${noun}` : `Pick this number on the ${noun}`,
    why: `This makes sure the ${noun} ${phone ? 'in your hand' : 'in front of you'} is the one being added.`,
  }
}

export function AddScannedSheet({ link, onClose }: { link: string; onClose: () => void }) {
  const offer = usePhoneAddScanned()
  const add = usePhoneScannedAdd()
  const [candidate, setCandidate] = useState<InviteCandidate | null>(null)
  const [roles, setRoles] = useState<Roles | null>(null)
  const [approver, setApprover] = useState<boolean | null>(null)
  const [details, setDetails] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const added = useRef(false)
  const cancelled = useRef(false)
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flight = useRef<Promise<number> | null>(null)
  const generation = useRef<number | null>(null)
  const { mutateAsync: start } = offer
  const number = add.data?.number
  const busy = add.isPending

  // Strict mode's remount must not offer the same code twice. The native
  // generation check cancels responses arriving after the sheet closed.
  useEffect(() => {
    if (started.current) return
    started.current = true
    const pending = start(link)
    flight.current = pending
    // The mutation exposes the error; handle rejection on this promise too.
    void pending.then((value) => { generation.current = value }, () => undefined)
  }, [link, start])

  const cancelOffer = useCallback(() => {
    if (added.current || cancelled.current) return
    cancelled.current = true
    if (generation.current !== null) {
      void phoneCloudInviteCancel(generation.current).catch(() => undefined)
    } else {
      void phoneCloudInviteCancel().catch(() => undefined)
      // Cancel may be processed before Tauri starts the offer command.
      // Cancel only its eventual generation, never a newer sheet's.
      void flight.current?.then((g) => phoneCloudInviteCancel(g), () => undefined).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    clearTimeout(leaving.current)
    return () => {
      leaving.current = setTimeout(cancelOffer, 0)
    }
  }, [cancelOffer])

  useEffect(() => {
    if (!offer.isSuccess || busy || number) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await phoneCloudInvitePoll()
        if (stopped) return
        if (result.state === 'candidate') setCandidate(result.candidate)
        else if (result.state === 'waiting') setCandidate(null)
        else {
          setCandidate(null)
          setError(CODE_TIMED_OUT)
          return
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e))
      }
      if (!stopped) timer = setTimeout(() => { void poll() }, INVITE_POLL_MS)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [offer.isSuccess, busy, number])

  const close = () => {
    // Face ID decides by itself: do not race a roster write.
    if (busy) return
    cancelOffer()
    onClose()
  }

  useEffect(() => {
    // Face ID can make the app inactive; it must not cancel its own Add.
    const hidden = () => { if (document.visibilityState === 'hidden' && !busy && !number) close() }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  })

  const asked = candidate ? { server: candidate.server ?? false, client: candidate.client ?? false } : null
  const chosen = roles ?? asked
  const confirm = () => {
    if (!candidate || !chosen) return
    add.mutate({ enrollmentId: candidate.enrollment_id, roles: chosen, approver: approver ?? Boolean(asked?.client) }, {
      onSuccess: () => { added.current = true },
    })
  }
  const failure = offer.error?.message ?? add.error?.message ?? error

  const copy = scannedCopy(candidate?.kind)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{number ? copy.number : copy.title}</DialogTitle>
          <DialogDescription>{number ? copy.why : copy.body}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3 text-xs leading-relaxed text-(--color-text-2)">
          {number ? (
            <p className="text-center font-mono text-6xl font-bold tabular-nums text-(--color-text)" aria-label="Number to tap">{number}</p>
          ) : (
            <>
              {candidate && asked && chosen ? (
                <>
                  <Button variant="link" size="sm" className="h-auto p-0" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
                    Details
                  </Button>
                  <Collapsible open={details} innerClassName="space-y-3">
                    <p>
                      Device ID: <span className="font-mono text-sm text-(--color-text)">{deviceLabel(candidate)}</span>
                    </p>
                    <RolesChoice value={chosen} allowed={asked} disabled={busy} onChange={setRoles} />
                    <label className="flex items-center gap-2">
                      <Checkbox checked={approver ?? Boolean(asked.client)} onCheckedChange={setApprover} disabled={busy} />
                      {CAN_ADD_DEVICES}
                    </label>
                  </Collapsible>
                </>
              ) : !failure && <p role="status">{copy.waiting}</p>}
            </>
          )}
          {failure && <Callout tone="error" role="alert">{failure}</Callout>}
        </div>
        <DialogFooter>
          {number ? <Button variant="primary" onClick={close}>Done</Button> : (
            <>
              <Button disabled={busy} onClick={close}>Cancel</Button>
              <Button variant="primary" disabled={!candidate || busy || Boolean(offer.error || error) || !chosen || (!chosen.server && !chosen.client)} onClick={confirm}>Add</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

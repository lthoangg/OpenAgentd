/** The phone approves the computer it scanned, then shows its number (spec 4.3.1). */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Roles } from '@/api/cloud'
import { deviceLabel, phoneCloudInviteCancel, phoneCloudInvitePoll, type InviteCandidate } from '@/api/phone-cloud'
import { RolesChoice } from '@/components/account/RolesChoice'
import { INVITE_POLL_MS } from '@/components/account/InviteSheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePhoneAddScanned, usePhoneScannedAdd } from '@/queries/phone-cloud'

export function AddComputerSheet({ link, onClose }: { link: string; onClose: () => void }) {
  const offer = usePhoneAddScanned()
  const add = usePhoneScannedAdd()
  const [candidate, setCandidate] = useState<InviteCandidate | null>(null)
  const [roles, setRoles] = useState<Roles | null>(null)
  const [approver, setApprover] = useState<boolean | null>(null)
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
          setError('This sign-in ended. Cancel on the computer, then sign in again to show a new code.')
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{number ? 'Pick this number on the computer' : 'Add this computer?'}</DialogTitle>
          <DialogDescription>{number ? 'The computer joins only after you pick it there.' : 'Only add a computer you are sitting at.'}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-3 text-xs leading-relaxed text-(--color-text-2)">
          {number ? (
            <p className="text-center font-mono text-4xl tabular-nums text-(--color-text)" aria-label="Number to pick">{number}</p>
          ) : (
            <>
              <p>It joins your account. Your devices can open sessions on it when used as a server; as a client it can open sessions on your other computers.</p>
              {candidate && asked && chosen ? (
                <>
                  <p className="font-mono text-sm text-(--color-text)">{deviceLabel(candidate)}</p>
                  <RolesChoice value={chosen} allowed={asked} disabled={busy} onChange={setRoles} />
                  <label className="flex items-center gap-2">
                    <Checkbox checked={approver ?? Boolean(asked.client)} onCheckedChange={setApprover} disabled={busy} />
                    Can approve other devices
                  </label>
                </>
              ) : !failure && <p role="status">Waiting for the computer…</p>}
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

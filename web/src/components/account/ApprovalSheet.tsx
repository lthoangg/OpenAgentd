/**
 * ApprovalSheet — adding a device that signed in, on a device that approves
 * (the phone, or a computer that is a signer).
 *
 * Opening it starts the approval (`begin`), which waits for the other device
 * to show its code. Only with that code on screen can the person compare it
 * with the other screen: "Codes match" stays disabled until then. The sheet
 * shows the roles the device asked for; the person may turn one off, never
 * one on (the boxes for roles it did not ask for are disabled). Confirming
 * asks for Face ID or Touch ID where the device has it; "Don't match" rejects
 * the request and says what that may mean. Closing the sheet any other way
 * without confirming rejects the request too: an approval is never left half
 * open.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import type { ApprovalView, Roles } from '@/api/cloud'
import { RolesChoice } from '@/components/account/RolesChoice'
import { groupCode } from '@/components/settings/pages/account-copy'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Mutation<V, R = unknown> {
  mutate: (variables: V, options?: { onSuccess?: (data: R) => void }) => void
  data?: R
  error: Error | null
  isPending: boolean
}

export interface ApprovalActions {
  begin: Mutation<string, ApprovalView>
  confirm: Mutation<{ enrollmentId: string; approver: boolean; roles: Roles }>
  reject: Mutation<string>
}

export function ApprovalSheet({
  enrollmentId,
  label,
  actions,
  onClose,
}: {
  enrollmentId: string
  /** "Linux · 9C02 E1B7 · VN · 1 min ago": the device, as the person sees it. */
  label: string
  actions: ApprovalActions
  onClose: () => void
}) {
  const { begin, confirm, reject } = actions
  const [rejected, setRejected] = useState(false)
  /** The person's choices, once the requested roles are known. */
  const [roles, setRoles] = useState<Roles | null>(null)
  const [approver, setApprover] = useState<boolean | null>(null)
  const started = useRef(false)
  /** Confirmed or rejected: closing then changes nothing. */
  const settled = useRef(false)
  const { mutate: startApproval } = begin

  // Once per sheet: a strict-mode remount must not start a second approval.
  useEffect(() => {
    if (started.current) return
    started.current = true
    startApproval(enrollmentId)
  }, [startApproval, enrollmentId])

  const view = begin.data ?? null
  const asked: Roles | null = view ? { server: view.server, client: view.client } : null
  const chosen = roles ?? asked
  // A device that opens sessions has someone at its screen: it approves too by default.
  const approves = approver ?? Boolean(asked?.client)
  const busy = confirm.isPending || reject.isPending
  const failure = begin.error ?? confirm.error ?? reject.error

  const close = () => {
    // A confirm in flight (Face ID, Touch ID) decides by itself; do not race it.
    if (!settled.current && !busy) {
      settled.current = true
      reject.mutate(enrollmentId)
    }
    onClose()
  }

  const dontMatch = () => {
    reject.mutate(enrollmentId, {
      onSuccess: () => {
        settled.current = true
        setRejected(true)
      },
    })
  }

  const codesMatch = () => {
    if (!chosen) return
    confirm.mutate({ enrollmentId, approver: approves, roles: chosen }, {
      onSuccess: () => {
        settled.current = true
        onClose()
      },
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add this device?</DialogTitle>
          {!rejected && <DialogDescription>{label}</DialogDescription>}
        </DialogHeader>
        <div className="mt-4 space-y-3 text-xs leading-relaxed text-(--color-text-2)">
          {rejected ? (
            <p role="status">Request cancelled. If you didn&apos;t start it, someone may be trying to join your account.</p>
          ) : (
            <>
              {begin.isPending && (
                <p role="status" className="flex items-center gap-2">
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  Waiting for the other device…
                </p>
              )}
              {view && (
                <p>
                  Does it show <strong className="font-mono text-base text-(--color-text)">{groupCode(view.code)}</strong>?
                </p>
              )}
              {chosen && asked && (
                <RolesChoice value={chosen} allowed={asked} disabled={busy} onChange={setRoles} />
              )}
              {view && (
                <label className="flex items-center gap-2">
                  <Checkbox checked={approves} onCheckedChange={setApprover} disabled={busy} />
                  Can approve other devices
                </label>
              )}
              {failure && <Callout tone="error" role="alert">{failure.message}</Callout>}
            </>
          )}
        </div>
        <DialogFooter>
          {rejected ? (
            <Button variant="primary" onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="default" disabled={begin.isPending || busy} onClick={dontMatch}>
                Don&apos;t match
              </Button>
              <Button
                variant="primary"
                disabled={!view || busy || !chosen || (!chosen.server && !chosen.client)}
                onClick={codesMatch}
              >
                Codes match
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

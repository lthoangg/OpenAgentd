/**
 * ApprovalSheet — approving another device onto the account, from the phone.
 *
 * Opening it starts the approval (`cloud_approve_begin`), which waits for
 * the other device to show its code. Only with that code on screen can the
 * person compare it with the other screen: "Codes match" stays disabled
 * until then. Confirming asks for Face ID natively; "Don't match" rejects the
 * request and says what that may mean. Closing the sheet any other way
 * without confirming rejects the request too: an approval is never left
 * half open.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { pendingLabel, type PendingRow } from '@/api/phone-cloud'
import { groupCode } from '@/components/settings/pages/account-copy'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePhoneApproveBegin, usePhoneApproveConfirm, usePhoneApproveReject } from '@/queries/phone-cloud'

export function ApprovalSheet({ row, onClose }: { row: PendingRow; onClose: () => void }) {
  const begin = usePhoneApproveBegin()
  const confirm = usePhoneApproveConfirm()
  const reject = usePhoneApproveReject()
  const [approver, setApprover] = useState(false)
  const [rejected, setRejected] = useState(false)
  const started = useRef(false)
  /** Confirmed or rejected: closing then changes nothing. */
  const settled = useRef(false)
  const { mutate: startApproval } = begin

  // Once per sheet: a strict-mode remount must not start a second approval.
  useEffect(() => {
    if (started.current) return
    started.current = true
    startApproval(row.enrollment_id)
  }, [startApproval, row.enrollment_id])

  const code = begin.data ?? null
  const busy = confirm.isPending || reject.isPending
  const failure = begin.error ?? confirm.error ?? reject.error

  const close = () => {
    // A confirm in flight (Face ID) decides by itself; do not race it.
    if (!settled.current && !busy) {
      settled.current = true
      reject.mutate(row.enrollment_id)
    }
    onClose()
  }

  const dontMatch = () => {
    reject.mutate(row.enrollment_id, {
      onSuccess: () => {
        settled.current = true
        setRejected(true)
      },
    })
  }

  const codesMatch = () => {
    confirm.mutate({ enrollmentId: row.enrollment_id, approver }, {
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
          <DialogTitle>Add this computer?</DialogTitle>
          {!rejected && <DialogDescription>{pendingLabel(row)}</DialogDescription>}
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
              {code && (
                <p>
                  Does it show <strong className="font-mono text-base text-(--color-text)">{groupCode(code)}</strong>?
                </p>
              )}
              {code && (
                <label className="flex items-center gap-2">
                  <Checkbox checked={approver} onCheckedChange={setApprover} disabled={busy} />
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
              <Button variant="primary" disabled={!code || busy} onClick={codesMatch}>
                Codes match
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

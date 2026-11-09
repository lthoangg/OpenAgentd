/**
 * While this computer approves devices for the account, asks every 30 s
 * whether a device signed in and waits (spec 4.5). A new request shows a
 * system notification with fixed text ("A device wants to join your
 * account", no device named) when the window is in the background, and a
 * prompt in the app; **Review** opens the approval sheet, which still needs
 * the 6-digit code. Desktop shell only; renders nothing otherwise.
 */
import { useEffect, useRef, useState } from 'react'

import type { CloudPending } from '@/api/cloud'
import { ApiValidationError } from '@/api/client/_shared'
import { pendingLabel } from '@/api/phone-cloud'
import { DesktopApprovalSheet } from '@/components/account/DesktopApprovalSheet'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { sendDesktopNotification } from '@/lib/desktop-notifications'
import { useCloudPendingQuery, useCloudStatusQuery } from '@/queries/cloud'

export const APPROVAL_TEXT = 'A device wants to join your account'

export function DesktopApprovalWatcher() {
  const status = useCloudStatusQuery().data
  const signer = status?.state === 'connected' && status.signer
  const [forbidden, setForbidden] = useState(false)
  const pendingQ = useCloudPendingQuery(signer && !forbidden)
  const seen = useRef(new Set<string>())
  const [prompt, setPrompt] = useState<CloudPending | null>(null)
  const [reviewing, setReviewing] = useState<CloudPending | null>(null)

  // Another computer's server (a window on a remote server): its account
  // routes answer only that computer, so stop asking.
  useEffect(() => {
    if (pendingQ.error instanceof ApiValidationError && pendingQ.error.status === 403) setForbidden(true)
  }, [pendingQ.error])

  useEffect(() => {
    const rows = pendingQ.data
    if (!rows) return
    const fresh = rows.filter((row) => !seen.current.has(row.enrollment_id))
    for (const row of rows) seen.current.add(row.enrollment_id)
    const newest = fresh.at(-1)
    if (!newest) return
    void sendDesktopNotification({
      kind: 'device_approval',
      notificationId: `approval-${newest.enrollment_id}`,
      title: 'OpenAgentd',
      body: APPROVAL_TEXT,
    })
    setPrompt((open) => open ?? newest)
  }, [pendingQ.data])

  // A request that ended (approved elsewhere, rejected, expired) closes its prompt.
  useEffect(() => {
    if (prompt && pendingQ.data && !pendingQ.data.some((row) => row.enrollment_id === prompt.enrollment_id)) setPrompt(null)
  }, [prompt, pendingQ.data])

  if (reviewing) return <DesktopApprovalSheet row={reviewing} onClose={() => setReviewing(null)} />
  if (!prompt) return null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) setPrompt(null) }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{APPROVAL_TEXT}</DialogTitle>
          <DialogDescription>{pendingLabel(prompt)}</DialogDescription>
        </DialogHeader>
        <p className="mt-4 text-xs leading-relaxed text-(--color-text-2)">
          Only approve a device you are signing in right now. You will compare a 6-digit code with its screen.
        </p>
        <DialogFooter>
          <Button variant="default" onClick={() => setPrompt(null)}>Not now</Button>
          <Button
            variant="primary"
            onClick={() => {
              setReviewing(prompt)
              setPrompt(null)
            }}
          >
            Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

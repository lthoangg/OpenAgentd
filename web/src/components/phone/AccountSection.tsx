/**
 * The phone's account at the top of the Servers screen, the app's first
 * screen: reachable before any server answers, in every state.
 *
 * - A guest sees one "Sign in" row; the offer itself is in the Account
 *   sheet it opens, so it shows once. (Scan QR code stays under the list.)
 * - A sign-in under way (signing in, recovery code, joining, invited) is one
 *   "Finish signing in" row that reopens the Account sheet on that step.
 * - A signed-in phone has an "Account" row, and an approver sees each
 *   device that asks to join, with Review.
 *
 * Nothing at all where this build cannot hold an account (`supported:
 * false`). Every row opens the Account sheet (`onOpen`).
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { pendingLabel, type DeviceRow, type PendingRow, type PhoneCloudStatus } from '@/api/phone-cloud'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { CAN_ADD_DEVICES, FEATURE_NAME, groupCode, noticeCopy } from '@/components/settings/pages/account-copy'
import { kindNoun } from '@/lib/device-words'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { ICON_SIZE, ROW_PAD, TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'
import { usePhoneCloudPending, usePhoneCloudStatus } from '@/queries/phone-cloud'

/** The short line under "Finish signing in", per step. */
function unfinishedLine(status: PhoneCloudStatus): string | null {
  switch (status.state) {
    case 'signing_in': return status.add_link && !status.recovering ? 'Scan its code with your other phone' : `Enter ${status.user_code} on the account page`
    case 'recovery': return 'Save your recovery code'
    case 'joining': return status.code ? `Check ${groupCode(status.code)} on your other phone` : 'Waiting for your other phone to add this one'
    case 'invited': return 'Waiting for your other phone to add this one'
    case 'scanned': return 'Tap Add on your other phone'
    case 'confirming': return 'Pick the number your other phone shows'
    default: return null
  }
}

/** The short line under "Account" once signed in. */
function accountLine(status: PhoneCloudStatus, devices: DeviceRow[] | undefined): string {
  switch (status.state) {
    case 'closing': return 'Scheduled for deletion · remote access paused'
    case 'unavailable': return 'Unavailable · remote access paused'
    case 'connected': {
      if (!devices) return 'Signed in'
      if (devices.length > 1) return `${devices.length} devices`
      return status.signer ? `This phone · ${CAN_ADD_DEVICES}` : 'This phone'
    }
    default: return 'Use your computers from anywhere'
  }
}

/** One tappable row: a title, a short line, and a chevron. */
function SheetRow({ title, line, onOpen }: { title: string; line: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-account-row=""
      className={cn(
        'flex min-h-(--phone-control) w-full items-center gap-3 text-left',
        ROW_PAD,
        'transition-colors duration-(--motion-instant) pointer-fine:hover:bg-(--bg-key)/40 active:bg-(--bg-key)/60',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', TEXT.label)}>{title}</span>
        <span className={cn('mt-0.5 block truncate', TEXT.hint)}>{line}</span>
      </span>
      <ChevronRight size={ICON_SIZE} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
    </button>
  )
}

function Notice({ status }: { status: PhoneCloudStatus }) {
  if (status.state !== 'guest' || !status.notice) return null
  const notice = noticeCopy(status.notice, status.retry_after)
  return <Callout tone={notice.tone ?? 'info'} title={notice.title} role="status">{notice.body}</Callout>
}

/** A request to join, for a phone that can add devices. */
function PendingCard({ row, onReview }: { row: PendingRow; onReview: () => void }) {
  return (
    <div data-pending-card="" className={cn('flex items-center gap-3 border-l-2 border-l-(--color-accent)', ROW_PAD)}>
      <span className="min-w-0 flex-1">
        <span className={cn('block', TEXT.label)}>{`A new ${kindNoun(row.kind)} wants to join`}</span>
        <span className={cn('mt-0.5 block truncate', TEXT.hint)}>{pendingLabel(row)}</span>
      </span>
      <Button size="sm" variant="primary" onClick={onReview}>Review</Button>
    </div>
  )
}

export function AccountSection({
  active,
  devices,
  onOpen,
}: {
  /** The screen is up: an approver's requests refresh only then. */
  active: boolean
  /** The account's devices, once loaded (for the line under "Account"). */
  devices: DeviceRow[] | undefined
  /** Opens the Account sheet, on whatever step the account is at. */
  onOpen: () => void
}) {
  const status = usePhoneCloudStatus().data
  const signer = status?.state === 'connected' && status.signer
  const pending = usePhoneCloudPending(active && signer).data ?? []
  const [reviewing, setReviewing] = useState<PendingRow | null>(null)

  if (!status) return null
  if (status.state === 'guest' && !status.supported) return null

  const unfinished = unfinishedLine(status)
  const guest = status.state === 'guest'
  const body = (
    <PanelSection title={FEATURE_NAME} flush>
      {pending.map((row) => <PendingCard key={row.enrollment_id} row={row} onReview={() => setReviewing(row)} />)}
      {unfinished
        ? <SheetRow title="Finish signing in" line={unfinished} onOpen={onOpen} />
        : <SheetRow title={guest ? 'Sign in' : 'Account'} line={accountLine(status, devices)} onOpen={onOpen} />}
    </PanelSection>
  )

  return (
    <div data-account-section="" className="space-y-3">
      <Notice status={status} />
      {body}
      {reviewing && <ApprovalSheet row={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  )
}

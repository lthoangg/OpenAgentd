/**
 * The phone's approval sheet: the shared one (`account/ApprovalSheet`) with
 * the phone shell's commands, which ask for Face ID natively.
 */
import { pendingLabel, type PendingRow } from '@/api/phone-cloud'
import { ApprovalSheet as Sheet } from '@/components/account/ApprovalSheet'
import { usePhoneApproveBegin, usePhoneApproveConfirm, usePhoneApproveReject } from '@/queries/phone-cloud'

export function ApprovalSheet({ row, onClose }: { row: PendingRow; onClose: () => void }) {
  const begin = usePhoneApproveBegin()
  const confirm = usePhoneApproveConfirm()
  const reject = usePhoneApproveReject()
  return (
    <Sheet
      enrollmentId={row.enrollment_id}
      label={pendingLabel(row)}
      actions={{ begin, confirm, reject }}
      onClose={onClose}
    />
  )
}

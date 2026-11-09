/**
 * The approval sheet on a computer that approves devices: the shared one
 * (`ApprovalSheet`) with this computer's `/api/cloud` routes, which ask for
 * Touch ID (or the login password) in the desktop app before the confirm.
 */
import type { CloudPending } from '@/api/cloud'
import { pendingLabel } from '@/api/phone-cloud'
import { ApprovalSheet } from '@/components/account/ApprovalSheet'
import { useCloudApproveBegin, useCloudApproveConfirm, useCloudApproveReject } from '@/queries/cloud'

export function DesktopApprovalSheet({ row, onClose }: { row: CloudPending; onClose: () => void }) {
  const begin = useCloudApproveBegin()
  const confirm = useCloudApproveConfirm()
  const reject = useCloudApproveReject()
  return <ApprovalSheet enrollmentId={row.enrollment_id} label={pendingLabel(row)} actions={{ begin, confirm, reject }} onClose={onClose} />
}

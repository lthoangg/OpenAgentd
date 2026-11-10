/**
 * DesktopAddDeviceSheet: a computer that approves adds a device with an
 * invitation (`InviteSheet`, the phone's rules), through this server's
 * `/api/cloud/invite/*`. Only the desktop app can open one: starting and
 * looking at candidates need its proof (no Touch ID; it keeps the link from
 * an agent's shell), and Add needs the same proof as approving, after
 * Touch ID or the login password where the Mac has one.
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  cloudApproveReject,
  cloudInviteAdd,
  cloudInviteCancel,
  cloudInvitePoll,
  cloudInviteStart,
  INVITE_ELSEWHERE,
} from '@/api/cloud'
import { InviteSheet, type InviteSheetActions } from '@/components/account/InviteSheet'
import { approvalProof } from '@/lib/approval-proof'
import { queryKeys } from '@/queries/keys'

async function inviteProof(id: string): Promise<string> {
  const proof = await approvalProof({ action: 'invite', id }, 'show an invitation')
  if (!proof) throw new Error(INVITE_ELSEWHERE)
  return proof
}

export function DesktopAddDeviceSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const actions = useMemo<InviteSheetActions>(() => ({
    start: async () => cloudInviteStart(await inviteProof('start')),
    poll: async (invite) => {
      if (!invite.slot_id) return { state: 'ended' }
      return cloudInvitePoll(invite.slot_id, await inviteProof(invite.slot_id))
    },
    cancel: cloudInviteCancel,
    add: async (c) => {
      // Its asked roles; it approves others when it opens sessions (a phone).
      const roles = { server: c.server ?? false, client: c.client ?? false }
      const approver = roles.client
      const proof = await approvalProof({ action: 'approve', id: c.enrollment_id, signer: approver, ...roles }, 'add a device to your account')
      if (!proof) return false
      const status = await cloudInviteAdd(c.enrollment_id, approver, roles, proof)
      queryClient.setQueryData(queryKeys.cloud.status(), status)
      void queryClient.invalidateQueries({ queryKey: queryKeys.cloud.devices() })
      return true
    },
    reject: (c) => cloudApproveReject(c.enrollment_id),
  }), [queryClient])
  return <InviteSheet actions={actions} description="This computer checks every device before it joins." onClose={onClose} />
}

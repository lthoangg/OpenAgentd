/**
 * AddDeviceSheet: the phone (an approver) adds a device with an invitation
 * (`account/InviteSheet`), through the shell's commands. Face ID happens
 * natively when the person taps Add.
 */
import { useMemo } from 'react'

import { phoneCloudApproveReject, phoneCloudInviteCancel, phoneCloudInvitePoll, phoneCloudInviteStart } from '@/api/phone-cloud'
import { InviteSheet, type InviteSheetActions } from '@/components/account/InviteSheet'
import { usePhoneInviteAdd } from '@/queries/phone-cloud'

export { INVITE_POLL_MS } from '@/components/account/InviteSheet'

export function AddDeviceSheet({ onClose }: { onClose: () => void }) {
  const add = usePhoneInviteAdd()
  const { mutateAsync } = add
  const actions = useMemo<InviteSheetActions>(() => ({
    start: phoneCloudInviteStart,
    poll: () => phoneCloudInvitePoll(),
    cancel: phoneCloudInviteCancel,
    add: async (c) => { await mutateAsync(c.enrollment_id); return true },
    reject: (c) => phoneCloudApproveReject(c.enrollment_id),
  }), [mutateAsync])
  return <InviteSheet actions={actions} description="Your phone checks every device before it joins." onClose={onClose} />
}

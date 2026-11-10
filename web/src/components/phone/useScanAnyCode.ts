/**
 * The phone's one QR scanner on the Servers screen, for both kinds of code:
 * an account invitation (`agentd://invite?…`, shown by a device of the
 * account under Account → Add a device) joins the account with this phone's
 * own key; a server's connect code (`openagentd://connect?…`, the desktop's
 * Network access card) fills the add-server form. Anything else gets one
 * message that names both.
 */
import { useState } from 'react'

import type { AppBackendPrefill } from '@/components/AppBackendPanel'
import { INVITE_PREFIX } from '@/components/settings/pages/join-with-link'
import { pickReachableUrl } from '@/hooks/useConnectLink'
import { parseConnectLink } from '@/lib/connect-link'
import { scanQrCode } from '@/lib/qr-scan'
import { usePhoneCloudStatus, usePhoneJoinInvite } from '@/queries/phone-cloud'

export const NOT_A_CODE =
  "That QR code is not an OpenAgentd code. Scan an invitation (Account → Add a device on a device in your account) or a server's connect code (Network access on your computer)."
export const CAMERA_OFF = 'Camera access is off. Turn it on for OpenAgentd in Settings to scan a code.'
export const ALREADY_IN = 'This phone is already in an account. To add another device, open Account → Add a device.'

export function useScanAnyCode({ onConnect, onJoining }: {
  /** A connect code: the add-server form takes it (nothing connects until Save and use). */
  onConnect: (prefill: AppBackendPrefill) => void
  /** An invitation was claimed: the account shows the Joining step. */
  onJoining: () => void
}) {
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = usePhoneCloudStatus().data
  const join = usePhoneJoinInvite()

  const scan = async () => {
    setError(null)
    setScanning(true)
    const outcome = await scanQrCode().finally(() => setScanning(false))
    if (outcome.kind === 'denied') {
      setError(CAMERA_OFF)
      return
    }
    if (outcome.kind !== 'scanned') return
    const text = outcome.text.trim()
    if (text.startsWith(INVITE_PREFIX)) {
      if (status && status.state !== 'guest') {
        setError(ALREADY_IN)
        return
      }
      join.mutate(text, { onSuccess: onJoining, onError: (e) => setError(e.message) })
      return
    }
    const link = parseConnectLink(text)
    if (!link) {
      setError(NOT_A_CODE)
      return
    }
    onConnect({ baseUrl: await pickReachableUrl(link.urls), accessKey: link.key })
  }

  return { scan, scanning, error, clearError: () => setError(null) }
}

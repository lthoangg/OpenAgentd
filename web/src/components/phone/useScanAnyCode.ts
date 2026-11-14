/**
 * The phone's one QR scanner on the Servers screen, for three kinds of code:
 * an account invitation (`agentd://invite?…`, shown by a device of the
 * account under Account → Add a device) joins the account with this phone's
 * own key; a server's connect code (`openagentd://connect?…`, the desktop's
 * Network access card) fills the add-server form. Anything else gets one
 * message that names all three. A computer's sign-in code (`agentd://add`)
 * opens Add this computer on a phone that approves devices. A phone that is
 * not signed in yet (or is part-way through) signs in first and then adds
 * the computer it scanned (`onAddAfterSignIn`), without a second scan.
 */
import { useState } from 'react'

import type { AppBackendPrefill } from '@/components/AppBackendPanel'
import { INVITE_PREFIX } from '@/components/settings/pages/join-with-link'
import { pickReachableUrl } from '@/hooks/useConnectLink'
import { parseConnectLink } from '@/lib/connect-link'
import { scanQrCode } from '@/lib/qr-scan'
import { usePhoneCloudStatus, usePhoneJoinInvite } from '@/queries/phone-cloud'

export const NOT_A_CODE =
  "That QR code is not an OpenAgentd code. Scan a computer's sign-in code (Account → Sign in), an invitation (Account → Add a device), or a server's connect code (Network access)."
export const CAMERA_OFF = 'Camera access is off. Turn it on for OpenAgentd in Settings to scan a code.'
export const ALREADY_IN = 'This phone is already in an account. To add another device, open Account → Add a device.'
export const ADD_NEEDS_IPHONE = 'Adding a computer needs the iPhone app for now.'

/** A sign-in on its way: the phone can finish it, then add the computer. */
const SIGNING_IN = new Set(['signing_in', 'recovery', 'joining', 'invited'])

export function useScanAnyCode({ onConnect, onJoining, onAddComputer, onAddAfterSignIn }: {
  /** A connect code: the add-server form takes it (nothing connects until Save and use). */
  onConnect: (prefill: AppBackendPrefill) => void
  /** An invitation was claimed: the account shows the Joining step. */
  onJoining: () => void
  /** A sign-in code, held only while the Add this computer sheet is open. */
  onAddComputer: (link: string) => void
  /** A sign-in code scanned before this phone can approve: sign in, then add it. */
  onAddAfterSignIn: (link: string) => void
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
    if (text.startsWith('agentd://add?')) {
      if (status?.state === 'guest' && !status.supported) {
        setError(ADD_NEEDS_IPHONE)
      } else if (status && (status.state === 'guest' || SIGNING_IN.has(status.state))) {
        onAddAfterSignIn(text)
      } else if (status?.state !== 'connected') {
        setError('Sign in on this phone before adding a computer. If this is your first device, sign in in the browser on the computer instead.')
      } else if (!status.signer) {
        setError('This phone cannot approve devices. Scan with a phone that can approve them.')
      } else {
        onAddComputer(text)
      }
      return
    }
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

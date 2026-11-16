/**
 * The phone's one QR scanner on the Computers screen, for three kinds of
 * code. The code a new device shows (`agentd://add`, spec 4.3.1: a new
 * iPhone or iPad on its first screen, a computer signing in) opens "Add
 * this …?" on a phone that can add devices; a phone that is not signed in
 * yet (or is part-way through) signs in first and then adds the device it
 * scanned (`onAddAfterSignIn`), without a second scan. An account
 * invitation (`agentd://invite?…`, a computer's Add a device) joins the
 * account with this phone's own key; a server's connect code
 * (`openagentd://connect?…`, the desktop's Network access card) fills the
 * add-server form. Anything else gets one message.
 */
import { useState } from 'react'

import type { AppBackendPrefill } from '@/components/AppBackendPanel'
import { CANT_ADD_DEVICES } from '@/components/settings/pages/remote-copy'
import { INVITE_PREFIX } from '@/components/settings/pages/join-with-link'
import { pickReachableUrl } from '@/hooks/useConnectLink'
import { parseConnectLink } from '@/lib/connect-link'
import { scanQrCode } from '@/lib/qr-scan'
import { usePhoneCloudStatus, usePhoneJoinInvite } from '@/queries/phone-cloud'

export const NOT_A_CODE =
  "That QR code is not an OpenAgentd code. Scan the code on the new iPhone, iPad or computer, or a computer's connect code."
export const CAMERA_OFF = 'Camera access is off. Turn it on for OpenAgentd in Settings to scan a code.'
export const ALREADY_IN = 'This phone is already in your account. To add another iPhone, iPad or computer, scan the code it shows.'
export const ADD_NEEDS_IPHONE = 'Adding devices needs the iPhone app for now.'
export const SIGN_IN_TO_ADD = 'Sign in on this phone before adding a device. If this is your first device, sign in on the computer instead.'

/** A sign-in on its way: the phone can finish it, then add the computer. */
const SIGNING_IN = new Set(['signing_in', 'recovery', 'joining', 'invited'])

export function useScanAnyCode({ onConnect, onJoining, onAddComputer, onAddAfterSignIn }: {
  /** A connect code: the add-server form takes it (nothing connects until Save and use). */
  onConnect: (prefill: AppBackendPrefill) => void
  /** An invitation was claimed: the account shows the Joining step. */
  onJoining: () => void
  /** A new device's code, held only while the Add this …? sheet is open. */
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
        setError(SIGN_IN_TO_ADD)
      } else if (!status.signer) {
        setError(CANT_ADD_DEVICES)
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

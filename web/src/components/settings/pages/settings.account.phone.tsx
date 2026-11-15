/**
 * Settings → Remote control on the phone. The account belongs to the phone
 * itself and is driven by the app shell's commands (`api/phone-cloud.ts`),
 * not by a server's `/api/cloud`. A guest sees the QR code their other
 * phone scans (`NewDeviceSignIn`), with Sign in with Google and the
 * recovery code as links under it; nothing here blocks or nags. The same
 * content serves Settings, the sheet the Computers screen opens
 * (`AccountSheet`), which has no router around it, and a new device's
 * first screen.
 *
 * Signed in: one list of the account's devices (`DeviceRows`), this phone
 * first with Sign out; key and role are under each device's Details.
 */
import { useState, type ReactNode } from 'react'

import { deviceLabel, isServer, pendingLabel, phoneCloudRenameDevice, type PendingRow } from '@/api/phone-cloud'
import { DeviceRows, onlyApproverIsMe, type ListedDevice } from '@/components/account/DeviceRows'
import { RecoveredNote } from '@/components/account/RecoverWithCode'
import { RecoveryStep } from '@/components/account/RecoveryStep'
import { AddDeviceSheet } from '@/components/phone/AddDeviceSheet'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { SettingsPage } from '@/components/settings/SettingsPage'
import {
  Body,
  ClosingCopy,
  FEATURE_NAME,
  GUEST_DESCRIPTION,
  groupCode,
  SigningInCopy,
  UnavailableCopy,
} from '@/components/settings/pages/account-copy'
import { InvitedCopy } from '@/components/settings/pages/join-with-link'
import { isNewDeviceStep, NewDeviceSignIn } from '@/components/phone/NewDeviceSignIn'
import { thisDeviceName } from '@/lib/device-words'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useAppStatusWithNames } from '@/lib/account-computers'
import { renameAccountComputer, renameAccountDevice } from '@/lib/computer-rename'
import { openExternalUrl } from '@/lib/open-external'
import {
  usePhoneCancel,
  usePhoneCloudDevices,
  usePhoneCloudPending,
  usePhoneCloudStatus,
  usePhoneConfirmRecovery,
  usePhoneMakeApprover,
  usePhoneRecover,
  usePhoneRecoveredAck,
  usePhoneRemoveDevice,
  usePhoneSignOut,
} from '@/queries/phone-cloud'

/** The account's devices, this phone first; an approver adds, removes, and lets another approve. */
function DevicesSection({ signer, recovered = false, onAdd, onSignOut, busy }: { signer: boolean; recovered?: boolean; onAdd: () => void; onSignOut: () => void; busy: boolean }) {
  const devicesQ = usePhoneCloudDevices(true)
  const remove = usePhoneRemoveDevice()
  const promote = usePhoneMakeApprover()
  const app = useAppStatusWithNames()
  // An older shell does not say what a device is used as: read it by kind.
  const devices = devicesQ.data?.map((device) => ({ ...device, server: isServer(device), client: device.client ?? !isServer(device) }))
  const rename = (device: ListedDevice) => {
    if (device.name !== undefined) {
      if (!device.me && !signer) return null
      return (name: string) => renameAccountDevice(app, device, name)
    }
    // An older shell: computers only, on the computer itself.
    return device.server && !device.me ? async (name: string) => { await renameAccountComputer(app ?? null, device.device_id, name) } : null
  }
  return (
    <>
      <DeviceRows
        devices={devices}
        loading={devicesQ.isLoading}
        noApproverNote={recovered}
        names={app?.computer_names}
        selfLabel="This phone"
        meSigner={signer}
        canChange
        onAdd={signer ? onAdd : undefined}
        onRemove={signer ? (deviceId) => remove.mutateAsync(deviceId) : undefined}
        removeEffect="It stops reaching your computers through your account."
        onMakeApprover={signer ? (deviceId) => promote.mutateAsync(deviceId) : undefined}
        rename={rename}
        renameHint={(device) => (rename(device) ? undefined : device.name !== undefined ? 'Only a device that can add devices can rename it.' : device.server ? 'Open this computer to rename it.' : undefined)}
        uploadName={(deviceId, name) => phoneCloudRenameDevice(deviceId, name)}
        onSignOut={onSignOut}
        signOutDisabled={busy}
      />
      {(devicesQ.error ?? remove.error) && (
        <Callout tone="error" role="alert">{(devicesQ.error ?? remove.error)?.message}</Callout>
      )}
    </>
  )
}

/** Requests from new devices, for a phone that approves. */
function PendingSection({ onReview }: { onReview: (row: PendingRow) => void }) {
  const pendingQ = usePhoneCloudPending(true)
  const rows = pendingQ.data ?? []
  if (rows.length === 0) return null
  return (
    <PanelSection title="Wants to join" description="Only add a device you are adding right now." flush>
      {rows.map((row) => (
        <PanelRow key={row.enrollment_id} label={pendingLabel(row)}>
          <Button size="sm" variant="primary" onClick={() => onReview(row)}>Review</Button>
        </PanelRow>
      ))}
    </PanelSection>
  )
}

export function PhoneAccountContent() {
  const statusQ = usePhoneCloudStatus()
  const status = statusQ.data
  const cancel = usePhoneCancel()
  const signOut = usePhoneSignOut()
  const confirmRecovery = usePhoneConfirmRecovery()
  const recover = usePhoneRecover()
  const recoveredAck = usePhoneRecoveredAck()
  const devicesQ = usePhoneCloudDevices(status?.state === 'connected')
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [reviewing, setReviewing] = useState<PendingRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [withCode, setWithCode] = useState(false)

  const busy = cancel.isPending || signOut.isPending || recover.isPending
  const failure = cancel.error ?? signOut.error ?? recover.error ?? statusQ.error
  // The only approver: signing out would leave nobody who can add devices.
  // Devices that left are not listed, so they do not count.
  const onlySigner = status?.state === 'connected' && status.signer && onlyApproverIsMe(devicesQ.data)

  const signOutButton = <Button size="sm" disabled={busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
  const cancelButton = <Button size="sm" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>
  /** From a waiting step: stop it, and open the recovery code. */
  const useRecoveryCode = () => {
    cancel.mutate()
    setWithCode(true)
  }
  const self = thisDeviceName()
  const thisOne = self === 'phone' ? 'this phone' : `this ${self}`

  let content: ReactNode = null
  // The QR code and its steps stay one element from guest to the number,
  // so a link the person opened (Google, the recovery code) stays open.
  if (status && isNewDeviceStep(status)) {
    content = <NewDeviceSignIn key={withCode ? 'recovery' : 'scan'} status={status} initialView={withCode ? 'recovery' : 'scan'} />
  }
  switch (status?.state) {
    case 'guest':
    case 'scanned':
    case 'confirming':
      // Drawn above, one element for all its steps (see `newDevice`); no
      // keys on this build (Android for now): no account UI at all.
      break
    case 'invited':
      content = (
        <PanelSection title="Joining">
          <Body>
            <InvitedCopy label={deviceLabel({ kind: status.kind, fingerprint: status.fingerprint })} />
            {cancelButton}
          </Body>
        </PanelSection>
      )
      break
    case 'signing_in':
      if (!status.recovering) break
      content = (
        <PanelSection title={status.recovering ? 'Recovering your account' : 'Signing in'}>
          <Body>
            {status.recovering && <p className="font-medium text-(--color-text)">Sign in in the browser to finish.</p>}
            <SigningInCopy url={status.url} userCode={status.user_code} fingerprint={status.fingerprint} />
            <div className="flex flex-wrap gap-2">
              {status.url.startsWith('https://') && (
                <Button variant="primary" size="sm" onClick={() => { void openExternalUrl(status.url) }}>Open page</Button>
              )}
              {cancelButton}
            </div>
          </Body>
        </PanelSection>
      )
      break
    case 'recovery':
      content = (
        <RecoveryStep code={status.code} check={status.check} busy={busy} confirm={confirmRecovery} onCancel={() => cancel.mutate()} />
      )
      break
    case 'joining':
      content = (
        <PanelSection title="Joining">
          <Body>
            <p>On a phone that can add devices, open OpenAgentd and tap Review. Add {thisOne} there.</p>
            {status.code && (
              <p>
                It shows the same number:{' '}
                <strong className="font-mono text-(--color-text)">{groupCode(status.code)}</strong>
              </p>
            )}
            {cancelButton}
            <p>
              <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={useRecoveryCode}>
                Lost your phone? Use your recovery code
              </Button>
            </p>
          </Body>
        </PanelSection>
      )
      break
    case 'connected':
      content = (
        <>
          {status.recovered && <RecoveredNote device="phone" busy={recoveredAck.isPending} onDone={() => recoveredAck.mutate()} />}
          <DevicesSection signer={status.signer} recovered={status.recovered === true} onAdd={() => setAdding(true)} onSignOut={() => setConfirmingSignOut(true)} busy={busy} />
          {status.signer && <PendingSection onReview={setReviewing} />}
        </>
      )
      break
    case 'closing':
      content = (
        <PanelSection title="Account">
          <Body>
            <ClosingCopy deletesAt={status.deletes_at} />
            {signOutButton}
          </Body>
        </PanelSection>
      )
      break
    case 'unavailable':
      content = (
        <PanelSection title="Account">
          <Body>
            <UnavailableCopy />
            {signOutButton}
          </Body>
        </PanelSection>
      )
      break
    default:
      break
  }

  return (
    <div className="space-y-6 md:space-y-8">
      {failure && <Callout tone="error" role="alert" title="That didn't work">{failure.message}</Callout>}
      {content}
      {reviewing && <ApprovalSheet row={reviewing} onClose={() => setReviewing(null)} />}
      {adding && <AddDeviceSheet onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={confirmingSignOut}
        onOpenChange={setConfirmingSignOut}
        title="Sign out of your account?"
        description={
          <>
            This device stops being reachable through your account. Local sessions and settings stay.
            {onlySigner && (
              <span className="mt-2 block">
                This phone is the only device that can add devices. Let another one add devices first, or keep your recovery code.
              </span>
            )}
          </>
        }
        confirmLabel="Sign out"
        onConfirm={() => signOut.mutateAsync().catch(() => undefined)}
      />
    </div>
  )
}

export function PhoneAccountSettingsPage() {
  const status = usePhoneCloudStatus().data
  return (
    <SettingsPage
      title={FEATURE_NAME}
      description={status && status.state !== 'guest' ? 'Optional: use your computers from your phone anywhere.' : GUEST_DESCRIPTION}
    >
      <PhoneAccountContent />
    </SettingsPage>
  )
}

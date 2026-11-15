/**
 * Settings → Account on the phone. The account belongs to the phone itself
 * and is driven by the app shell's commands (`api/phone-cloud.ts`), not by a
 * server's `/api/cloud`. A guest sees one sentence and **Sign in**, with
 * the rest under **Other ways to sign in** (an invitation from a device of
 * the account, scanned or pasted, and the recovery code for an account
 * whose only approving phone is lost); nothing here blocks or nags. The
 * same content serves Settings and the sheet the Servers screen opens
 * (`AccountSheet`), which has no router around it.
 *
 * Signed in: one list of the account's devices (`DeviceRows`), this phone
 * first with Sign out; key and role are under each device's Details.
 */
import { useState, type ReactNode } from 'react'

import { deviceLabel, isServer, pendingLabel, phoneCloudRenameDevice, type PendingRow } from '@/api/phone-cloud'
import { DeviceRows, onlyApproverIsMe, type ListedDevice } from '@/components/account/DeviceRows'
import { RecoveredNote, RecoverWithCode } from '@/components/account/RecoverWithCode'
import { RecoveryStep } from '@/components/account/RecoveryStep'
import { AddDeviceSheet } from '@/components/phone/AddDeviceSheet'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { QrScanOverlay } from '@/components/phone/QrScanOverlay'
import { SettingsPage } from '@/components/settings/SettingsPage'
import {
  Body,
  ClosingCopy,
  GUEST_DESCRIPTION,
  groupCode,
  noticeCopy,
  SigningInCopy,
  UnavailableCopy,
} from '@/components/settings/pages/account-copy'
import { INVITE_PREFIX, InvitedCopy, JoinWithLink } from '@/components/settings/pages/join-with-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Collapsible } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { SectionCard } from '@/components/ui/section-card'
import { useAppStatusWithNames } from '@/lib/account-computers'
import { renameAccountComputer, renameAccountDevice } from '@/lib/computer-rename'
import { openExternalUrl } from '@/lib/open-external'
import { cancelQrScan, canScanQr, scanQrCode } from '@/lib/qr-scan'
import {
  usePhoneCancel,
  usePhoneCloudDevices,
  usePhoneCloudPending,
  usePhoneCloudStatus,
  usePhoneConfirmRecovery,
  usePhoneJoinInvite,
  usePhoneMakeApprover,
  usePhoneRecover,
  usePhoneRecoveredAck,
  usePhoneRemoveDevice,
  usePhoneSignIn,
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
        renameHint={(device) => (rename(device) ? undefined : device.name !== undefined ? 'Only a device that approves new devices can rename it.' : device.server ? 'Open this computer to rename it.' : undefined)}
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

/**
 * The alternative to signing in: an invitation another device of the
 * account shows, scanned or pasted. Signing in is the main way, for a new
 * account and for joining one.
 */
function JoinByInvitation({ busy, onJoin }: { busy: boolean; onJoin: (link: string) => void }) {
  const [scanning, setScanning] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const scan = async () => {
    setScanError(null)
    setScanning(true)
    const outcome = await scanQrCode().finally(() => setScanning(false))
    if (outcome.kind === 'denied') setScanError('Allow camera access in Settings to scan the invitation.')
    if (outcome.kind !== 'scanned') return
    const text = outcome.text.trim()
    if (text.startsWith(INVITE_PREFIX)) onJoin(text)
    else setScanError('That QR code is not an invitation. On your other phone: Settings → Account → Add a device.')
  }
  return (
    <div className="space-y-3">
        <p className="font-medium text-(--color-text)">Have an invitation?</p>
        <p>A device already in your account can show one: on it, open Settings → Account → Add a device, then scan its code here.</p>
        <div className="flex flex-wrap gap-2">
          {canScanQr() && (
            <Button variant="primary" size="sm" disabled={busy || scanning} onClick={() => { void scan() }}>Scan invitation</Button>
          )}
          {!pasting && <Button size="sm" disabled={busy} onClick={() => setPasting(true)}>Paste link</Button>}
        </div>
        {scanError && <p role="alert" className="text-xs text-(--color-error)">{scanError}</p>}
        {pasting && (
          <JoinWithLink busy={busy} onJoin={onJoin} hint="On your other phone, choose Can't scan? Use a link, and paste it here." />
        )}
      {scanning && (
        <QrScanOverlay
          hint="Scan the code on your other phone: Settings → Account → Add a device."
          onCancel={() => { void cancelQrScan() }}
        />
      )}
    </div>
  )
}

/** Requests from new devices, for a phone that approves. */
function PendingSection({ onReview }: { onReview: (row: PendingRow) => void }) {
  const pendingQ = usePhoneCloudPending(true)
  const rows = pendingQ.data ?? []
  if (rows.length === 0) return null
  return (
    <PanelSection title="Pending approvals" description="Someone is asking to join your account. Only approve a request you started." flush>
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
  const signIn = usePhoneSignIn()
  const join = usePhoneJoinInvite()
  const cancel = usePhoneCancel()
  const signOut = usePhoneSignOut()
  const confirmRecovery = usePhoneConfirmRecovery()
  const recover = usePhoneRecover()
  const recoveredAck = usePhoneRecoveredAck()
  const devicesQ = usePhoneCloudDevices(status?.state === 'connected')
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [reviewing, setReviewing] = useState<PendingRow | null>(null)
  const [adding, setAdding] = useState(false)
  const [otherWays, setOtherWays] = useState(false)
  const [withCode, setWithCode] = useState(false)

  const busy = signIn.isPending || join.isPending || cancel.isPending || signOut.isPending || recover.isPending
  const failure = signIn.error ?? join.error ?? cancel.error ?? signOut.error ?? recover.error ?? statusQ.error
  // The only approver: signing out would leave nobody who can add devices.
  // Devices that left are not listed, so they do not count.
  const onlySigner = status?.state === 'connected' && status.signer && onlyApproverIsMe(devicesQ.data)

  const signOutButton = <Button size="sm" disabled={busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
  const cancelButton = <Button size="sm" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>
  // A wrong recovery code: the form opens again, to try once more.
  const guestNotice = status?.state === 'guest' ? status.notice : null
  const [seenNotice, setSeenNotice] = useState(guestNotice)
  if (guestNotice !== seenNotice) {
    setSeenNotice(guestNotice)
    if (guestNotice === 'wrong_recovery_code') {
      setOtherWays(true)
      setWithCode(true)
    }
  }

  /** From a waiting step: stop it, and open the recovery code under Other ways. */
  const useRecoveryCode = () => {
    cancel.mutate()
    setOtherWays(true)
    setWithCode(true)
  }

  let content: ReactNode = null
  switch (status?.state) {
    case 'guest': {
      // No keys on this build (Android for now): no account UI at all.
      if (!status.supported) break
      const notice = status.notice ? noticeCopy(status.notice, status.retry_after) : null
      content = (
        <>
          {notice && (
            <Callout tone={notice.tone ?? 'info'} title={notice.title} role="status">{notice.body}</Callout>
          )}
          {/* No heading: the page title already says Account. */}
          <SectionCard>
            <div className="px-3 py-3 md:px-4 md:py-4">
              <Body>
                <p className="text-(--color-text)">Sign in to use your computers from anywhere.</p>
                <div>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => signIn.mutate()}>
                    {status.notice === 'expired' ? 'Sign in again' : 'Sign in'}
                  </Button>
                </div>
                <Button variant="link" size="sm" className="h-auto px-0!" aria-expanded={otherWays} onClick={() => setOtherWays((open) => !open)}>
                  Other ways to sign in
                </Button>
                <Collapsible open={otherWays} innerClassName="space-y-4">
                  <JoinByInvitation busy={busy} onJoin={(link) => join.mutate(link)} />
                  {withCode ? (
                    <RecoverWithCode device="phone" busy={busy} onRecover={(code) => recover.mutate(code)} onCancel={() => setWithCode(false)} />
                  ) : (
                    <p>
                      <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={() => setWithCode(true)}>
                        Lost your phone? Use your recovery code
                      </Button>
                    </p>
                  )}
                </Collapsible>
              </Body>
            </div>
          </SectionCard>
        </>
      )
      break
    }
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
            <p>Approve this phone on a device already in your account: Settings → Account → Pending approvals.</p>
            {status.code && (
              <p>
                Code to compare:{' '}
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
                This phone is the only device that can approve others. Let another device approve first, or keep your recovery code.
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
      title="Account"
      description={status && status.state !== 'guest' ? 'Optional: use your computers from your phone anywhere.' : GUEST_DESCRIPTION}
    >
      <PhoneAccountContent />
    </SettingsPage>
  )
}

/**
 * Settings → Remote control — this computer's optional account for Remote control.
 * Guest is the default and is never blocked or nagged.
 *
 * Signed out: one sentence and **Sign in**. On an empty account this
 * computer creates it (after the recovery code); otherwise a phone scans the
 * QR code the sign-in step shows and the person picks the phone's number
 * here, or a device already in the account approves it after comparing a
 * 6-digit code (the browser way, under "Can't use your phone?"). The rest
 * sits under **Other ways to sign in**: an invitation link, and the recovery
 * code for an account whose only approving phone is lost. A computer signs
 * in with both sharing choices on (the CLI still offers roles). **Connect
 * your phone** (footer, palette) opens this page and signs in at once
 * (`lib/connect-phone`).
 *
 * Signed in: one list of the account's devices (`DeviceRows`), this
 * computer first with Sign out; its status, key, role and remote sessions
 * are under its Details. A computer that approves devices adds and removes
 * them, approves pending requests with the code and Touch ID, and lets
 * another device approve too; a note says when it is the only one that can.
 * Only this computer may change its account; anyone else (a phone viewing a
 * remote server) sees the status and a hint.
 */
import { useEffect, useReducer, useState, type ReactNode } from 'react'

import { APPROVE_ELSEWHERE, REMOVE_ELSEWHERE, cloudRenameDevice, type CloudPending, type CloudStatus, type RelayState } from '@/api/cloud'
import { deviceLabel, pendingLabel } from '@/api/phone-cloud'
import { DesktopAddDeviceSheet } from '@/components/account/DesktopAddDeviceSheet'
import { DesktopApprovalSheet } from '@/components/account/DesktopApprovalSheet'
import { DeviceRows, onlyApproverIsMe, type ListedDevice } from '@/components/account/DeviceRows'
import { RecoveredNote, RecoverWithCode } from '@/components/account/RecoverWithCode'
import { RecoveryStep } from '@/components/account/RecoveryStep'
import { COMPUTER_ROLES, rolesAsked } from '@/components/account/RolesChoice'
import { ApiValidationError } from '@/api/client/_shared'
import { ConnectQrCode } from '@/components/ConnectQrCode'
import { SettingsPage } from '@/components/settings/SettingsPage'
import {
  Body,
  ClosingCopy,
  FEATURE_NAME,
  GUEST_DESCRIPTION,
  groupCode,
  noticeCopy,
  PICK_NUMBER,
  SCANNED_COPY,
  ScanCodeCopy,
  SigningInCopy,
  UnavailableCopy,
} from '@/components/settings/pages/remote-copy'
import { InvitedCopy, JoinWithLink } from '@/components/settings/pages/join-with-link'
import {
  PAIRING_NONE,
  browserWayOpen,
  codeOpen,
  linkOpen,
  otherWaysOpen,
  pairingStep,
  sheetOf,
  signOutAsked,
} from '@/components/settings/pages/pairing-ui-state'
import { Button, buttonVariants } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Collapsible } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { useAppStatusWithNames } from '@/lib/account-computers'
import { BUILT_IN_NAME_KEY, computerNameKey } from '@/lib/app-backend'
import { canApproveHere } from '@/lib/approval-proof'
import { consumeConnectPhone, useConnectPhoneStore } from '@/lib/connect-phone'
import { NAME_NEEDS_UPDATE, renameAccountComputer, renameAccountDevice, renameComputerInUse, serverInUseKeepsName } from '@/lib/computer-rename'
import { isDesktopShell } from '@/lib/desktop-shell'
import {
  useCloudCancelMutation,
  useCloudConfirmRecovery,
  useCloudDevicesQuery,
  useCloudJoinMutation,
  useCloudLoginMutation,
  useCloudLogoutMutation,
  useCloudMakeApprover,
  useCloudPendingQuery,
  useCloudPickNumber,
  useCloudRecover,
  useCloudRecoveredAck,
  useCloudRemoveDevice,
  useCloudStatusQuery,
} from '@/queries/cloud'

function relayText(relay: RelayState): string {
  switch (relay.state) {
    case 'online':
      return 'Reachable from your devices'
    case 'connecting':
      return 'Connecting…'
    case 'offline':
      return 'Offline, retrying'
    case 'off':
      return 'Your other devices cannot open it'
    case 'taken_over':
      return 'Another copy of this computer is using its account. Retrying every few minutes'
    case 'paused': {
      const until = relay.until === null
        ? ''
        : ` until ${new Date(relay.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      return `Paused: today's allowance is used up${until}`
    }
  }
}

const isForbidden = (error: unknown) => error instanceof ApiValidationError && error.status === 403

const RENAME_NEEDS_APPROVER = 'Only a device that can add devices can rename it.'

/** The account's devices, this computer first; an approver adds, removes, and lets another approve. */
function DevicesSection({ status, onAdd, onSignOut, busy }: {
  status: Extract<CloudStatus, { state: 'connected' }>
  onAdd: () => void
  onSignOut: () => void
  busy: boolean
}) {
  const devicesQ = useCloudDevicesQuery(true)
  const remove = useCloudRemoveDevice()
  const promote = useCloudMakeApprover()
  const app = useAppStatusWithNames()
  // Removing and promoting sign the account's device list: only the desktop app can prove the person asked.
  const here = canApproveHere()
  // A remote viewer: these routes answer only this computer.
  if (isForbidden(devicesQ.error)) {
    return (
      <PanelSection title="Status" flush>
        <PanelRow label="Signed in" description={relayText(status.relay)} />
      </PanelSection>
    )
  }
  const devices = devicesQ.data
  // An older server keeps no account names: in the desktop app this
  // computer's name is the one remembered for its built-in server.
  const me = isDesktopShell() ? devices?.find((device) => device.me) : undefined
  const ownName = app?.computer_names?.[BUILT_IN_NAME_KEY]
  const names = me && ownName ? { ...app?.computer_names, [me.device_id]: ownName } : app?.computer_names
  const onOwnServer = me !== undefined && computerNameKey(app) === BUILT_IN_NAME_KEY
  const rename = (device: ListedDevice) => {
    if (device.name !== undefined) {
      if (!device.me && !status.signer) return null
      return (name: string) => renameAccountDevice(app, device, name)
    }
    if (device.me) return onOwnServer && serverInUseKeepsName() ? async (name: string) => { await renameComputerInUse(app, name) } : null
    if (device.server && isDesktopShell()) return async (name: string) => { await renameAccountComputer(app ?? null, device.device_id, name) }
    return null
  }
  const renameHint = (device: ListedDevice) => {
    if (rename(device)) return undefined
    if (device.name !== undefined) return RENAME_NEEDS_APPROVER
    if (device.me) return onOwnServer ? NAME_NEEDS_UPDATE : 'Switch to this computer to rename it.'
    return device.server ? 'Open this computer to rename it.' : undefined
  }
  return (
    <>
      <DeviceRows
        devices={devices}
        loading={devicesQ.isLoading}
        noApproverNote={status.recovered === true}
        names={names}
        selfLabel="This computer"
        selfLine={relayText(status.relay)}
        selfFacts={[
          { label: 'Status', value: relayText(status.relay) },
          { label: 'Remote sessions', value: String(status.sessions) },
        ]}
        meSigner={status.signer}
        canChange={here}
        changeElsewhere={REMOVE_ELSEWHERE}
        onAdd={status.signer ? onAdd : undefined}
        onRemove={status.signer ? (deviceId) => remove.mutateAsync(deviceId) : undefined}
        removeEffect="It stops reaching your devices through your account."
        onMakeApprover={status.signer ? (deviceId) => promote.mutateAsync(deviceId) : undefined}
        rename={rename}
        renameHint={renameHint}
        uploadName={(deviceId, name) => cloudRenameDevice(deviceId, name)}
        onSignOut={onSignOut}
        signOutDisabled={busy}
      />
      {(devicesQ.error ?? remove.error) && (
        <Callout tone="error" role="alert">{(devicesQ.error ?? remove.error)?.message}</Callout>
      )}
    </>
  )
}

/** Requests from devices that signed in, for a computer that approves. */
function PendingSection({ onReview }: { onReview: (row: CloudPending) => void }) {
  const pendingQ = useCloudPendingQuery(true)
  const rows = pendingQ.data ?? []
  if (rows.length === 0) return null
  // Approving signs the account's device list: only the desktop app can prove the person asked.
  const here = canApproveHere()
  const description = here ? 'A device wants to join your account. Only add a device you are adding right now.' : APPROVE_ELSEWHERE
  return (
    <PanelSection title="Wants to join" description={description} flush>
      {rows.map((row) => (
        <PanelRow key={row.enrollment_id} label={pendingLabel(row)} description={rolesAsked(row)}>
          {here && <Button size="sm" variant="primary" onClick={() => onReview(row)}>Review</Button>}
        </PanelRow>
      ))}
    </PanelSection>
  )
}

/** The browser page and its code, with Open page. */
function BrowserWay({ status, readOnly }: { status: Extract<CloudStatus, { state: 'signing_in' }>; readOnly: boolean }) {
  return (
    <>
      <SigningInCopy url={status.url} userCode={status.user_code} fingerprint={status.fingerprint} />
      {!readOnly && status.url.startsWith('https://') && (
        <a href={status.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
          Open page
        </a>
      )}
    </>
  )
}

export function RemoteSettingsPage() {
  const statusQ = useCloudStatusQuery()
  const login = useCloudLoginMutation()
  const join = useCloudJoinMutation()
  const cancel = useCloudCancelMutation()
  const logout = useCloudLogoutMutation()
  const pickNumber = useCloudPickNumber()
  const confirmRecovery = useCloudConfirmRecovery()
  const recover = useCloudRecover()
  const recoveredAck = useCloudRecoveredAck()

  const status: CloudStatus | undefined = statusQ.data
  // What the page has open, kept per screen (``pairing-ui-state.ts``). It
  // follows the status in render, so a new screen never paints with the
  // last one's folds open.
  const [pairingUi, sendPairing] = useReducer(pairingStep, PAIRING_NONE)
  const [seenStatus, setSeenStatus] = useState<CloudStatus | undefined>(undefined)
  if (status !== seenStatus) {
    setSeenStatus(status)
    if (status) sendPairing({ type: 'status', status })
  }
  const otherWays = otherWaysOpen(pairingUi)
  const withLink = linkOpen(pairingUi)
  const withCode = codeOpen(pairingUi)
  const browserWay = browserWayOpen(pairingUi)
  const sheet = sheetOf(pairingUi)
  const askSignOut = () => sendPairing({ type: 'signOut', open: true })
  const connected = status?.state === 'connected'
  // Shared with the devices list (one query): for the sign-out warning.
  const devicesQ = useCloudDevicesQuery(connected)
  const mutations = [login, join, cancel, logout, pickNumber, recover]
  // Not this computer: the status stays visible, the buttons give way to a hint.
  const readOnly = mutations.some((m) => isForbidden(m.error))
  const failure = mutations.map((m) => m.error).find((e) => e && !isForbidden(e))
  const busy = mutations.some((m) => m.isPending)

  // Connect your phone: sign in once the status says this computer is a
  // guest; a sign-in already under way just shows. Each request once.
  const connectRequested = useConnectPhoneStore((s) => s.requested)
  const state = status?.state
  const { mutate: signIn } = login
  useEffect(() => {
    if (!state || !consumeConnectPhone()) return
    if (state === 'guest') signIn(COMPUTER_ROLES)
  }, [connectRequested, state, signIn])

  /** From a waiting step: stop it, and open the recovery code under Other ways. */
  const useRecoveryCode = () => {
    sendPairing({ type: 'recoveryNext' })
    cancel.mutate()
  }
  const lostPhone = !readOnly && (
    <p>
      <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={useRecoveryCode}>
        Lost your phone? Use your recovery code
      </Button>
    </p>
  )
  const cancelButton = (
    <Button size="sm" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>
  )
  const signOutButton = (
    <Button size="sm" disabled={busy} onClick={askSignOut}>Sign out</Button>
  )

  let content: ReactNode = null
  switch (status?.state) {
    case 'guest': {
      const notice = status.notice ? noticeCopy(status.notice, status.retry_after) : null
      content = (
        <>
          {notice && (
            <Callout tone={notice.tone ?? 'info'} title={notice.title} role="status">
              {notice.body}
            </Callout>
          )}
          <PanelSection title="Sign in">
            <Body>
                <p className="text-(--color-text)">Sign in to reach this computer from your phone, anywhere.</p>
                {!readOnly && (
                  <>
                    <div>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => login.mutate(COMPUTER_ROLES)}>
                        {status.notice === 'expired' ? 'Sign in again' : 'Sign in'}
                      </Button>
                    </div>
                    <Button variant="link" size="sm" className="h-auto px-0!" aria-expanded={otherWays} onClick={() => sendPairing({ type: 'otherWays' })}>
                      Other ways to sign in
                    </Button>
                    <Collapsible open={otherWays} innerClassName="space-y-4">
                      {withLink ? (
                        <JoinWithLink
                          busy={busy}
                          onJoin={(link) => join.mutate({ link, roles: COMPUTER_ROLES })}
                          hint="On another computer in your account, open Settings → Remote control → Add a device, choose Can't scan? Use a link, and paste the link here."
                        />
                      ) : (
                        <p>
                          Have an invitation link?{' '}
                          <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={() => sendPairing({ type: 'withLink' })}>
                            Join with a link
                          </Button>
                        </p>
                      )}
                      {withCode ? (
                        <RecoverWithCode
                          device="computer"
                          busy={busy}
                          onRecover={(code) => recover.mutate({ code, roles: COMPUTER_ROLES })}
                          onCancel={() => sendPairing({ type: 'withCode', open: false })}
                        />
                      ) : (
                        <p>
                          <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={() => sendPairing({ type: 'withCode', open: true })}>
                            Lost your phone? Use your recovery code
                          </Button>
                        </p>
                      )}
                    </Collapsible>
                  </>
                )}
            </Body>
          </PanelSection>
        </>
      )
      break
    }
    case 'signing_in':
      content = status.recovering ? (
        <PanelSection title="Recovering your account">
          <Body>
            <p className="font-medium text-(--color-text)">Sign in in the browser to finish.</p>
            <BrowserWay status={status} readOnly={readOnly} />
            {!readOnly && <div>{cancelButton}</div>}
          </Body>
        </PanelSection>
      ) : (
        <PanelSection title="Signing in">
          <Body>
            {status.add_link ? (
              <>
                <div className="flex flex-wrap items-start gap-4">
                  <ConnectQrCode value={status.add_link} size={168} label="Sign-in QR code" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <ScanCodeCopy minutes={Math.max(1, Math.round(status.expires_in / 60))} />
                    {!readOnly && cancelButton}
                  </div>
                </div>
                <Button variant="link" size="sm" className="h-auto px-0!" aria-expanded={browserWay} onClick={() => sendPairing({ type: 'browserWay' })}>
                  Can&apos;t use your phone? Sign in in the browser
                </Button>
                <Collapsible open={browserWay} innerClassName="space-y-3">
                  <BrowserWay status={status} readOnly={readOnly} />
                  {lostPhone}
                </Collapsible>
              </>
            ) : (
              <>
                <BrowserWay status={status} readOnly={readOnly} />
                {!readOnly && <div>{cancelButton}</div>}
              </>
            )}
          </Body>
        </PanelSection>
      )
      break
    case 'recovery':
      content = status.code && status.check ? (
        <RecoveryStep
          code={status.code}
          check={status.check}
          busy={busy}
          confirm={confirmRecovery}
          onCancel={() => cancel.mutate()}
        />
      ) : (
        <PanelSection title="Setting up">
          <Body>
            <p>This computer is setting up a new account. Finish on its own screen.</p>
          </Body>
        </PanelSection>
      )
      break
    case 'joining':
      content = (
        <PanelSection title="Joining">
          <Body>
            <p>On a phone that can add devices, open OpenAgentd and tap Review. Add this computer there.</p>
            {status.code && (
              <p>
                Code to compare:{' '}
                <strong className="font-mono text-(--color-text)">{groupCode(status.code)}</strong>
              </p>
            )}
            {!readOnly && cancelButton}
            {lostPhone}
          </Body>
        </PanelSection>
      )
      break
    case 'invited':
      content = (
        <PanelSection title="Joining">
          <Body>
            <InvitedCopy label={deviceLabel({ kind: status.kind, fingerprint: status.fingerprint })} />
            {!readOnly && cancelButton}
          </Body>
        </PanelSection>
      )
      break
    case 'scanned':
      content = (
        <PanelSection title="Joining">
          <Body>
            <p>{SCANNED_COPY}</p>
            <p>
              This device: <strong className="font-mono text-(--color-text)">{status.fingerprint}</strong>
            </p>
            {!readOnly && cancelButton}
          </Body>
        </PanelSection>
      )
      break
    case 'confirming':
      content = (
        <PanelSection title="Joining">
          <Body>
            {status.choices && !readOnly ? (
              <>
                <p className="font-medium text-(--color-text)">{PICK_NUMBER}</p>
                <div className="flex gap-2">
                  {status.choices.map((n) => (
                    <Button key={n} size="lg" className="min-w-14 font-mono text-base tabular-nums" disabled={busy} onClick={() => pickNumber.mutate(n)}>
                      {n}
                    </Button>
                  ))}
                </div>
                <p>
                  No number on your phone?{' '}
                  <Button variant="link" size="sm" className="h-auto px-0!" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>
                  : this computer joins nothing.
                </p>
              </>
            ) : (
              <p>This computer is joining an account. Finish on its own screen.</p>
            )}
          </Body>
        </PanelSection>
      )
      break
    case 'connected':
      content = readOnly ? (
        <PanelSection title="Status" flush>
          <PanelRow label="Signed in" description={relayText(status.relay)} />
        </PanelSection>
      ) : (
        <>
          {status.recovered && <RecoveredNote device="computer" busy={recoveredAck.isPending} onDone={() => recoveredAck.mutate()} />}
          <DevicesSection status={status} onAdd={() => sendPairing({ type: 'sheet', sheet: { kind: 'add' } })} onSignOut={askSignOut} busy={busy} />
          {status.signer && <PendingSection onReview={(row: CloudPending) => sendPairing({ type: 'sheet', sheet: { kind: 'review', row } })} />}
        </>
      )
      break
    case 'closing':
      content = (
        <PanelSection title="Status">
          <Body>
            <ClosingCopy deletesAt={status.deletes_at} />
            {!readOnly && signOutButton}
          </Body>
        </PanelSection>
      )
      break
    case 'unavailable':
      content = (
        <PanelSection title="Status">
          <Body>
            <UnavailableCopy />
          </Body>
        </PanelSection>
      )
      break
    default:
      break
  }

  const onlyApprover = connected && status.signer && onlyApproverIsMe(devicesQ.data)
  return (
    <SettingsPage
      title={FEATURE_NAME}
      description={status && status.state !== 'guest' ? 'Optional: use this computer from your phone anywhere.' : GUEST_DESCRIPTION}
      loading={statusQ.isLoading}
      error={statusQ.error}
    >
      {readOnly && (
        <Callout tone="info" role="status">
          Manage this computer&apos;s account with <code className="font-mono">agentd remote login</code> on that computer.
        </Callout>
      )}
      {failure instanceof Error && (
        <Callout tone="error" role="alert" title="That didn't work">{failure.message}</Callout>
      )}
      {content}
      {sheet.kind === 'review' && <DesktopApprovalSheet row={sheet.row} onClose={() => sendPairing({ type: 'sheet', sheet: { kind: 'none' } })} />}
      {sheet.kind === 'add' && <DesktopAddDeviceSheet onClose={() => sendPairing({ type: 'sheet', sheet: { kind: 'none' } })} />}
      <ConfirmDialog
        open={signOutAsked(pairingUi)}
        onOpenChange={(open) => sendPairing({ type: 'signOut', open })}
        title="Sign out of your account?"
        description={
          <>
            This device stops being reachable through your account. Local sessions and settings stay.
            {onlyApprover && (
              <span className="mt-2 block">
                This computer is the only device that can add devices. Let another one add devices first, or keep your recovery code.
              </span>
            )}
          </>
        }
        confirmLabel="Sign out"
        onConfirm={() => logout.mutateAsync().catch(() => undefined)}
      />
    </SettingsPage>
  )
}

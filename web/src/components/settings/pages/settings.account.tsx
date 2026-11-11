/**
 * Settings → Account — this computer's optional OpenAgentd Cloud account.
 * Guest is the default and is never blocked or nagged. **Sign in** is the
 * way in, with **Use as server** and **Use as client** (both on): on an
 * empty account this computer creates it (after the recovery code), and
 * otherwise a device already in the account approves it after comparing a
 * 6-digit code. An invitation link is the alternative. Once connected, a
 * computer that approves devices lists the account's devices and the
 * pending requests, and approves one with the code and Touch ID; in the
 * desktop app it also shows an invitation QR code (**Add a device**) that a
 * phone scans to join, added only after Add and Touch ID. Only this
 * computer may change its account; anyone else (a phone viewing a remote
 * server) sees the status and a hint.
 */
import { useState, type ReactNode } from 'react'

import { APPROVE_ELSEWHERE, REMOVE_ELSEWHERE, type CloudPending, type CloudStatus, type RelayState, type Roles } from '@/api/cloud'
import { deviceLabel, pendingLabel } from '@/api/phone-cloud'
import { DesktopAddDeviceSheet } from '@/components/account/DesktopAddDeviceSheet'
import { DesktopApprovalSheet } from '@/components/account/DesktopApprovalSheet'
import { RecoveryStep } from '@/components/account/RecoveryStep'
import { COMPUTER_ROLES, RolesChoice, rolesLabel } from '@/components/account/RolesChoice'
import { ApiValidationError } from '@/api/client/_shared'
import { SettingsPage } from '@/components/settings/SettingsPage'
import {
  Body,
  ClosingCopy,
  GUEST_DESCRIPTION,
  groupCode,
  noticeCopy,
  OfferCopy,
  SigningInCopy,
  UnavailableCopy,
} from '@/components/settings/pages/account-copy'
import { InvitedCopy, JoinWithLink } from '@/components/settings/pages/join-with-link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { canApproveHere } from '@/lib/approval-proof'
import {
  useCloudCancelMutation,
  useCloudConfirmRecovery,
  useCloudDevicesQuery,
  useCloudJoinMutation,
  useCloudLoginMutation,
  useCloudLogoutMutation,
  useCloudPendingQuery,
  useCloudRemoveDevice,
  useCloudStatusQuery,
} from '@/queries/cloud'

function relayText(relay: RelayState): string {
  switch (relay.state) {
    case 'online':
      return 'Reachable from your devices through your account'
    case 'connecting':
      return 'Connecting…'
    case 'offline':
      return 'Offline, retrying'
    case 'off':
      return 'Not used as a server: your other devices do not reach this one'
    case 'taken_over':
      return 'Taken over: another copy of this computer uses its account keys. Retrying every few minutes'
    case 'paused': {
      const until = relay.until === null
        ? ''
        : ` until ${new Date(relay.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      return `Paused: today's relay allowance is used up${until}`
    }
  }
}

const isForbidden = (error: unknown) => error instanceof ApiValidationError && error.status === 403

/** The account's devices; an approver can add a device and remove the others. */
function DevicesSection({ canRemove, onAdd }: { canRemove: boolean; onAdd?: () => void }) {
  const devicesQ = useCloudDevicesQuery(true)
  const remove = useCloudRemoveDevice()
  const [removing, setRemoving] = useState<string | null>(null)
  // Removing signs the account's device list: only the desktop app can prove the person asked.
  const here = canApproveHere()
  // A remote viewer: these routes answer only this computer.
  if (isForbidden(devicesQ.error)) return null
  return (
    <>
      <PanelSection
        title="Devices"
        description={canRemove && !here ? REMOVE_ELSEWHERE : undefined}
        flush
        actions={onAdd && here && <Button size="sm" variant="primary" onClick={onAdd}>Add a device</Button>}
      >
        {devicesQ.isLoading && <PanelRow label="Loading devices…" />}
        {devicesQ.data?.map((device) => (
          <PanelRow
            key={device.device_id}
            label={deviceLabel(device)}
            description={(
              <span className="flex flex-wrap gap-x-2">
                {device.me && <span>This computer</span>}
                <span>{rolesLabel(device)}</span>
                {device.signer && <span>Approver</span>}
              </span>
            )}
          >
            {canRemove && here && !device.me && (
              <Button size="sm" variant="danger-subtle" aria-label={`Remove ${deviceLabel(device)}`} onClick={() => setRemoving(device.device_id)}>
                Remove
              </Button>
            )}
          </PanelRow>
        ))}
      </PanelSection>
      {(devicesQ.error ?? remove.error) && (
        <Callout tone="error" role="alert">{(devicesQ.error ?? remove.error)?.message}</Callout>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title="Remove this device?"
        description="It stops reaching your devices through your account."
        confirmLabel="Remove"
        onConfirm={() => (removing ? remove.mutateAsync(removing).catch(() => undefined) : undefined)}
      />
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
  const description = here ? 'A device is asking to join your account. Only approve a request you started.' : APPROVE_ELSEWHERE
  return (
    <PanelSection title="Pending approvals" description={description} flush>
      {rows.map((row) => (
        <PanelRow key={row.enrollment_id} label={pendingLabel(row)} description={`Asks to be: ${rolesLabel(row).toLowerCase()}`}>
          {here && <Button size="sm" variant="primary" onClick={() => onReview(row)}>Review</Button>}
        </PanelRow>
      ))}
    </PanelSection>
  )
}

export function AccountSettingsPage() {
  const statusQ = useCloudStatusQuery()
  const login = useCloudLoginMutation()
  const join = useCloudJoinMutation()
  const cancel = useCloudCancelMutation()
  const logout = useCloudLogoutMutation()
  const confirmRecovery = useCloudConfirmRecovery()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [roles, setRoles] = useState<Roles>(COMPUTER_ROLES)
  const [withLink, setWithLink] = useState(false)
  const [reviewing, setReviewing] = useState<CloudPending | null>(null)
  const [adding, setAdding] = useState(false)

  const status: CloudStatus | undefined = statusQ.data
  const mutations = [login, join, cancel, logout]
  const noRole = !roles.server && !roles.client
  // Not this computer: the status stays visible, the buttons give way to a hint.
  const readOnly = mutations.some((m) => isForbidden(m.error))
  const failure = mutations.map((m) => m.error).find((e) => e && !isForbidden(e))
  const busy = mutations.some((m) => m.isPending)

  const signOutButton = (
    <Button size="sm" disabled={busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
  )
  const cancelButton = (
    <Button size="sm" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>
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
          <PanelSection title="Account">
            <Body>
              <OfferCopy />
              {!readOnly && (
                <>
                  <RolesChoice value={roles} onChange={setRoles} disabled={busy} />
                  <Button variant="primary" size="sm" disabled={busy || noRole} onClick={() => login.mutate(roles)}>
                    {status.notice === 'expired' ? 'Sign in again' : 'Sign in'}
                  </Button>
                  <p>
                    If your account has devices already, one of them approves this computer after you compare a
                    6-digit code. Otherwise this computer sets the account up.
                  </p>
                  {withLink ? (
                    <JoinWithLink
                      busy={busy || noRole}
                      onJoin={(link) => join.mutate({ link, roles })}
                      hint="On a device in your account, open Settings → Account → Add a device, choose Can't scan? Use a link, and paste the link here."
                    />
                  ) : (
                    <p>
                      Have an invitation link?{' '}
                      <Button variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={() => setWithLink(true)}>
                        Join with a link instead
                      </Button>
                    </p>
                  )}
                </>
              )}
            </Body>
          </PanelSection>
        </>
      )
      break
    }
    case 'signing_in':
      content = (
        <PanelSection title="Signing in">
          <Body>
            <SigningInCopy url={status.url} userCode={status.user_code} fingerprint={status.fingerprint} />
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                {status.url.startsWith('https://') && (
                  <a
                    href={status.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: 'primary', size: 'sm' })}
                  >
                    Open page
                  </a>
                )}
                {cancelButton}
              </div>
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
            <p>Approve this computer on a device already in your account: Settings → Account → Pending approvals.</p>
            {status.code && (
              <p>
                Code to compare:{' '}
                <strong className="font-mono text-(--color-text)">{groupCode(status.code)}</strong>
              </p>
            )}
            {!readOnly && cancelButton}
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
    case 'connected':
      content = (
        <PanelSection title="Account" flush actions={!readOnly && signOutButton}>
          <PanelRow label="Status" description={relayText(status.relay)} />
          <PanelRow label="This device">
            <span className="font-mono text-xs text-(--color-text-2)">{status.fingerprint}</span>
          </PanelRow>
          {status.server !== undefined && (
            <PanelRow label="Used as">
              <span className="text-xs text-(--color-text-2)">{rolesLabel({ server: status.server, client: status.client ?? false })}</span>
            </PanelRow>
          )}
          <PanelRow label="Role">
            <span className="text-xs text-(--color-text-2)">{status.signer ? 'Approves devices' : 'Member'}</span>
          </PanelRow>
          <PanelRow label="Remote sessions">
            <span className="text-xs tabular-nums text-(--color-text-2)">{status.sessions}</span>
          </PanelRow>
        </PanelSection>
      )
      if (!readOnly) {
        content = (
          <>
            {content}
            <DevicesSection canRemove={status.signer} onAdd={status.signer ? () => setAdding(true) : undefined} />
            {status.signer && <PendingSection onReview={setReviewing} />}
          </>
        )
      }
      break
    case 'closing':
      content = (
        <PanelSection title="Account">
          <Body>
            <ClosingCopy deletesAt={status.deletes_at} />
            {!readOnly && signOutButton}
          </Body>
        </PanelSection>
      )
      break
    case 'unavailable':
      content = (
        <PanelSection title="Account">
          <Body>
            <UnavailableCopy />
          </Body>
        </PanelSection>
      )
      break
    default:
      break
  }

  return (
    <SettingsPage
      title="Account"
      description={status && status.state !== 'guest' ? 'Optional: reach this computer from your phone anywhere.' : GUEST_DESCRIPTION}
      loading={statusQ.isLoading}
      error={statusQ.error}
    >
      {readOnly && (
        <Callout tone="info" role="status">
          Manage this computer&apos;s account with <code className="font-mono">agentd cloud login</code> on that computer.
        </Callout>
      )}
      {failure instanceof Error && (
        <Callout tone="error" role="alert" title="That didn't work">{failure.message}</Callout>
      )}
      {content}
      {reviewing && <DesktopApprovalSheet row={reviewing} onClose={() => setReviewing(null)} />}
      {adding && <DesktopAddDeviceSheet onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={confirmingSignOut}
        onOpenChange={setConfirmingSignOut}
        title="Sign out of your account?"
        description="This device stops being reachable through your account. Local sessions and settings stay."
        confirmLabel="Sign out"
        onConfirm={() => logout.mutateAsync().catch(() => undefined)}
      />
    </SettingsPage>
  )
}

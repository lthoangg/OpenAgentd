/**
 * Settings → Account on the phone. The account belongs to the phone itself
 * and is driven by the app shell's commands (`api/phone-cloud.ts`), not by a
 * server's `/api/cloud`. A guest sees an offer and nothing else: nothing here
 * blocks or nags. The same content serves Settings and the sheet the Servers
 * screen opens (`AccountSheet`), which has no router around it.
 */
import { useState, type ReactNode } from 'react'

import { deviceLabel, pendingLabel, type PendingRow } from '@/api/phone-cloud'
import { AddDeviceSheet } from '@/components/phone/AddDeviceSheet'
import { ApprovalSheet } from '@/components/phone/ApprovalSheet'
import { QrScanOverlay } from '@/components/phone/QrScanOverlay'
import { SettingsPage } from '@/components/settings/SettingsPage'
import {
  Body,
  ClosingCopy,
  GUEST_DESCRIPTION,
  groupCode,
  NOTICES,
  OfferCopy,
  SigningInCopy,
  UnavailableCopy,
} from '@/components/settings/pages/account-copy'
import { INVITE_PREFIX, InvitedCopy, JoinWithLink } from '@/components/settings/pages/join-with-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { openExternalUrl } from '@/lib/open-external'
import { cancelQrScan, canScanQr, scanQrCode } from '@/lib/qr-scan'
import {
  usePhoneCancel,
  usePhoneCloudDevices,
  usePhoneCloudPending,
  usePhoneCloudStatus,
  usePhoneConfirmRecovery,
  usePhoneJoinInvite,
  usePhoneRemoveDevice,
  usePhoneSignIn,
  usePhoneSignOut,
} from '@/queries/phone-cloud'

/** Recovery codes are dash-separated groups; five to a line. */
const GROUPS_PER_LINE = 5

function lines(code: string): string[] {
  const groups = code.split('-')
  const out: string[] = []
  for (let i = 0; i < groups.length; i += GROUPS_PER_LINE) out.push(groups.slice(i, i + GROUPS_PER_LINE).join(' '))
  return out
}

/**
 * The recovery code, once, then two groups typed back. The code is never
 * selectable and has no Copy button: the clipboard is readable by other apps.
 */
function RecoveryStep({ code, check, onCancel, busy }: { code: string; check: [number, number]; onCancel: () => void; busy: boolean }) {
  const [step, setStep] = useState<'show' | 'check'>('show')
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const confirm = usePhoneConfirmRecovery()
  const typing = { autoComplete: 'off', autoCapitalize: 'characters', spellCheck: false, className: 'h-9 font-mono' } as const

  if (step === 'show') {
    return (
      <PanelSection title="Recovery code">
        <Body>
          <p className="font-medium text-(--color-text)">Save your recovery code.</p>
          <p>
            If you lose every device that can approve others, this code is the only way back into your account.
            OpenAgentd can&apos;t recover it for you.
          </p>
          <div
            data-sensitive=""
            className="select-none space-y-1 rounded-sm border border-(--color-border) bg-(--bg-key) p-3 font-mono text-sm text-(--color-text) [-webkit-touch-callout:none] [-webkit-user-select:none]"
            onCopy={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {lines(code).map((line) => <div key={line}>{line}</div>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => setStep('check')}>I saved it</Button>
            <Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
          </div>
        </Body>
      </PanelSection>
    )
  }
  return (
    <PanelSection title="Check your recovery code">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          confirm.mutate({ first: first.trim(), second: second.trim() })
        }}
      >
        <Field label={`Type group ${check[0]}`} htmlFor="recovery-first">
          <Input id="recovery-first" value={first} onChange={(event) => setFirst(event.target.value)} {...typing} />
        </Field>
        <Field label={`Type group ${check[1]}`} htmlFor="recovery-second">
          <Input id="recovery-second" value={second} onChange={(event) => setSecond(event.target.value)} {...typing} />
        </Field>
        {confirm.error && <p role="alert" className="text-xs text-(--color-error)">{confirm.error.message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={confirm.isPending || !first.trim() || !second.trim()}>
            Confirm
          </Button>
          <Button size="sm" disabled={confirm.isPending} onClick={() => setStep('show')}>Show the code again</Button>
          <Button size="sm" disabled={busy || confirm.isPending} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </PanelSection>
  )
}

/** The account's phone and computers; an approver can add and remove the others. */
function DevicesSection({ canRemove, onAdd }: { canRemove: boolean; onAdd?: () => void }) {
  const devicesQ = usePhoneCloudDevices(true)
  const remove = usePhoneRemoveDevice()
  const [removing, setRemoving] = useState<string | null>(null)
  return (
    <>
      <PanelSection
        title="Devices"
        flush
        actions={onAdd && <Button size="sm" variant="primary" onClick={onAdd}>Add a device</Button>}
      >
        {devicesQ.isLoading && <PanelRow label="Loading devices…" />}
        {devicesQ.data?.map((device) => (
          <PanelRow
            key={device.device_id}
            label={deviceLabel(device)}
            description={device.me || device.signer ? (
              <span className="flex flex-wrap gap-x-2">
                {device.me && <span>This phone</span>}
                {device.signer && <span>Approver</span>}
              </span>
            ) : undefined}
          >
            {canRemove && !device.me && (
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
        description="It stops reaching your computers through your account."
        confirmLabel="Remove"
        onConfirm={() => (removing ? remove.mutateAsync(removing).catch(() => undefined) : undefined)}
      />
    </>
  )
}

/**
 * Joining an account another phone already has: scan the invitation it
 * shows (the default), or paste its link. Sign in stays the way to set up
 * a new account, or to join with a 6-digit code.
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
    <PanelSection title="Add this phone to your account">
      <Body>
        <p>Already have OpenAgentd on another phone? On it, open Settings → Account → Add a device, then scan its code here.</p>
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
      </Body>
      {scanning && (
        <QrScanOverlay
          hint="Scan the code on your other phone: Settings → Account → Add a device."
          onCancel={() => { void cancelQrScan() }}
        />
      )}
    </PanelSection>
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
  const devicesQ = usePhoneCloudDevices(status?.state === 'connected')
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [reviewing, setReviewing] = useState<PendingRow | null>(null)
  const [adding, setAdding] = useState(false)

  const busy = signIn.isPending || join.isPending || cancel.isPending || signOut.isPending
  const failure = signIn.error ?? join.error ?? cancel.error ?? signOut.error ?? statusQ.error
  // The only approver: signing out would leave nobody who can add devices.
  const onlySigner = status?.state === 'connected' && status.signer
    && devicesQ.data !== undefined && !devicesQ.data.some((d) => !d.me && d.signer)

  const signOutButton = <Button size="sm" disabled={busy} onClick={() => setConfirmingSignOut(true)}>Sign out</Button>
  const cancelButton = <Button size="sm" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button>

  let content: ReactNode = null
  switch (status?.state) {
    case 'guest': {
      // No keys on this build (Android for now): no account UI at all.
      if (!status.supported) break
      const notice = status.notice ? NOTICES[status.notice] : null
      content = (
        <>
          {notice && (
            <Callout tone={notice.tone ?? 'info'} title={notice.title} role="status">{notice.body}</Callout>
          )}
          <PanelSection title="Account">
            <Body>
              <OfferCopy />
              <Button variant="primary" size="sm" disabled={busy} onClick={() => signIn.mutate()}>
                {status.notice === 'expired' ? 'Sign in again' : 'Sign in'}
              </Button>
            </Body>
          </PanelSection>
          <JoinByInvitation busy={busy} onJoin={(link) => join.mutate(link)} />
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
        <PanelSection title="Signing in">
          <Body>
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
      content = <RecoveryStep code={status.code} check={status.check} busy={busy} onCancel={() => cancel.mutate()} />
      break
    case 'joining':
      content = (
        <PanelSection title="Joining">
          <Body>
            <p>Approve this phone on your other phone: Settings → Account.</p>
            {status.code && (
              <p>
                Code to compare:{' '}
                <strong className="font-mono text-(--color-text)">{groupCode(status.code)}</strong>
              </p>
            )}
            {cancelButton}
          </Body>
        </PanelSection>
      )
      break
    case 'connected':
      content = (
        <>
          <PanelSection title="Account" flush actions={signOutButton}>
            <PanelRow label="This device">
              <span className="font-mono text-xs text-(--color-text-2)">{status.fingerprint}</span>
            </PanelRow>
            <PanelRow label="Role">
              <span className="text-xs text-(--color-text-2)">{status.signer ? 'Approves devices' : 'Member'}</span>
            </PanelRow>
          </PanelSection>
          <DevicesSection canRemove={status.signer} onAdd={status.signer ? () => setAdding(true) : undefined} />
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
                This phone is the only device that can approve others. Make another device an approver first, or keep your recovery code.
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

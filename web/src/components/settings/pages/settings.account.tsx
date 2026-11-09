/**
 * Settings → Account — this computer's optional OpenAgentd Cloud account.
 * Guest is the default and is never blocked or nagged. Joining is by the
 * invitation link the phone shows (the default: a computer cannot scan),
 * or by signing in and comparing a 6-digit code (the fallback). Only this
 * computer may change its account; anyone else (a phone viewing a remote
 * server) sees the status and a hint.
 */
import { useState, type ReactNode } from 'react'

import type { CloudStatus, RelayState } from '@/api/cloud'
import { deviceLabel } from '@/api/phone-cloud'
import { ApiValidationError } from '@/api/client/_shared'
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
import { InvitedCopy, JoinWithLink } from '@/components/settings/pages/join-with-link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import {
  useCloudCancelMutation,
  useCloudJoinMutation,
  useCloudLoginMutation,
  useCloudLogoutMutation,
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
    case 'paused': {
      const until = relay.until === null
        ? ''
        : ` until ${new Date(relay.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      return `Paused: today's relay allowance is used up${until}`
    }
  }
}

const isForbidden = (error: unknown) => error instanceof ApiValidationError && error.status === 403

export function AccountSettingsPage() {
  const statusQ = useCloudStatusQuery()
  const login = useCloudLoginMutation()
  const join = useCloudJoinMutation()
  const cancel = useCloudCancelMutation()
  const logout = useCloudLogoutMutation()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  const status: CloudStatus | undefined = statusQ.data
  const mutations = [login, join, cancel, logout]
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
      const notice = status.notice ? NOTICES[status.notice] : null
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
                  <JoinWithLink
                    busy={busy}
                    onJoin={(link) => join.mutate(link)}
                    hint="On your phone, open Settings → Account → Add a device, choose Can't scan? Use a link, and paste the link here."
                  />
                  <p>
                    No link?{' '}
                    <Button variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={() => login.mutate()}>
                      {status.notice === 'expired' ? 'Sign in with a code again' : 'Sign in with a code instead'}
                    </Button>
                  </p>
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
    case 'joining':
      content = (
        <PanelSection title="Joining">
          <Body>
            <p>Approve this computer on your phone: Settings → Account.</p>
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
          <PanelRow label="Role">
            <span className="text-xs text-(--color-text-2)">{status.signer ? 'Approves devices' : 'Member'}</span>
          </PanelRow>
          <PanelRow label="Remote sessions">
            <span className="text-xs tabular-nums text-(--color-text-2)">{status.sessions}</span>
          </PanelRow>
        </PanelSection>
      )
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
          Manage this computer&apos;s account with <code className="font-mono">agentd cloud join</code> on that computer.
        </Callout>
      )}
      {failure instanceof Error && (
        <Callout tone="error" role="alert" title="That didn't work">{failure.message}</Callout>
      )}
      {content}
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

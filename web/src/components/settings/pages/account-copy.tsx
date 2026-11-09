/**
 * Wording the desktop and phone Account pages share: the guest offer, the
 * sign-in instructions, the notices that explain why a device is a guest
 * again, and the closing / unavailable states. One place, so the two
 * pages never drift apart.
 */
import type { ReactNode } from 'react'

import type { CloudNotice } from '@/api/cloud'

export const GUEST_DESCRIPTION = 'Optional. Everything works without an account.'

export const NOTICES: Record<CloudNotice, { title?: string; body: string; tone?: 'info' | 'warning' }> = {
  expired: {
    title: 'The sign-in code expired.',
    body: 'If your browser said you are on the waitlist, you can finish once you are approved. Everything on this device keeps working.',
  },
  empty_account: {
    body: 'This account has no devices yet. Set it up in the OpenAgentd app on your phone first, then sign in here again.',
  },
  revoked: {
    title: 'This device was removed from your account.',
    body: 'It was signed out and keeps working on its own. Your local sessions and settings are unchanged.',
  },
  deleted: {
    title: 'Account deleted.',
    body: 'This device was signed out and keeps working on its own. Your local sessions and settings are unchanged.',
  },
  denied: { body: 'Sign-in was denied on the account page.' },
  commit_mismatch: { body: 'The request was cancelled: the codes did not match.' },
  confirm_mismatch: {
    body: "The account's answer did not match the invitation, so this device did not join. Nothing was changed.",
    tone: 'warning',
  },
  invite_invalid: { body: 'That is not an invitation link. Copy it again from your phone.' },
  join_ended: { body: 'The request to join ended: it was cancelled, expired, or the invitation was used.' },
  signed_out: { body: 'Signed out. Local sessions and settings are unchanged.' },
  failed: {
    body: "Something went wrong with this computer's account keys. Sign in again to start over.",
    tone: 'warning',
  },
}

/** `https://account.openagentd.dev/device?x=1` → `account.openagentd.dev/device`. */
export function displayUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    return host + (pathname === '/' ? '' : pathname)
  } catch {
    return url
  }
}

/** `418207` → `418 207`. */
export const groupCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code)

export function Body({ children }: { children: ReactNode }) {
  return <div className="space-y-3 text-xs leading-relaxed text-(--color-text-2)">{children}</div>
}

/** The guest's offer. Optional, and says so. */
export function OfferCopy() {
  return (
    <>
      <p className="font-medium text-(--color-text)">Reach your computer from anywhere.</p>
      <p>
        Sign in to use your computers from your phone away from home, and get notified when
        agents finish. It&apos;s optional: everything else works without an account.
      </p>
    </>
  )
}

/** What to do on the account page while a sign-in waits. */
export function SigningInCopy({ url, userCode, fingerprint }: { url: string; userCode: string; fingerprint: string }) {
  return (
    <>
      <p>
        Open <strong className="text-(--color-text)">{displayUrl(url)}</strong> and enter{' '}
        <strong className="font-mono text-(--color-text)">{userCode}</strong>. Check that the
        page shows this device:{' '}
        <strong className="font-mono text-(--color-text)">{fingerprint}</strong>.
      </p>
      <p className="italic">If your browser says you are on the waitlist, you can finish once you are approved.</p>
    </>
  )
}

export function ClosingCopy({ deletesAt }: { deletesAt: number | null }) {
  return (
    <p>
      <strong className="text-(--color-text)">
        Account scheduled for deletion
        {deletesAt !== null && ` on ${new Date(deletesAt).toLocaleDateString(undefined, { dateStyle: 'long' })}`}.
      </strong>{' '}
      Remote access is paused. To keep your account, sign in at account.openagentd.dev and choose Keep account.
      Everything here keeps working.
    </p>
  )
}

export function UnavailableCopy() {
  return (
    <p>
      <strong className="text-(--color-text)">Account unavailable.</strong> Remote access is paused.
      Contact OpenAgentd if this continues; this device keeps checking now and then. Everything here
      keeps working.
    </p>
  )
}

/**
 * Wording the desktop and phone Account pages share: the guest offer, the
 * sign-in instructions, the notices that explain why a device is a guest
 * again, and the closing / unavailable states. One place, so the two
 * pages never drift apart.
 */
import type { ReactNode } from 'react'

import type { CloudNotice } from '@/api/cloud'
import { isAndroidDevice } from '@/lib/device-words'

export const GUEST_DESCRIPTION = 'Optional. Everything works without an account.'

/** The one name of the feature, wherever a person reads it (DESIGN.md, "Plain words"). */
export const FEATURE_NAME = 'Remote control'
/** The one expiry wording, wherever a code ran out. */
export const CODE_TIMED_OUT = 'This code timed out. Show a new one.'
/** The one wording of the signer role, wherever a person reads it. */
export const CAN_ADD_DEVICES = 'Can add devices'
/** A phone that cannot add devices tried to. */
export const CANT_ADD_DEVICES = `This ${isAndroidDevice() ? 'phone' : 'iPhone'} can't add devices. Use the phone you set up first.`


export interface NoticeCopy {
  title?: string
  body: string
  tone?: 'info' | 'warning'
}

export const NOTICES: Record<CloudNotice, NoticeCopy> = {
  expired: { body: CODE_TIMED_OUT },
  empty_account: {
    body: 'This account has no devices yet. Sign in again to set it up on this device.',
  },
  roles: { body: 'A device can only get the roles it asked for, and needs at least one.' },
  revoked: {
    title: 'This device was removed from your account.',
    body: 'It was signed out and keeps working on its own. Your local sessions and settings are unchanged.',
  },
  deleted: {
    title: 'Account deleted.',
    body: 'This device was signed out and keeps working on its own. Your local sessions and settings are unchanged.',
  },
  denied: { body: 'Sign-in was denied on the account page.' },
  commit_mismatch: { body: 'Not added. Try again.' },
  confirm_mismatch: {
    body: "Not added: the answer didn't match. Nothing was changed. Try again.",
    tone: 'warning',
  },
  wrong_number: {
    body: "Not added. That wasn't the number on your phone. Sign in to try again.",
    tone: 'warning',
  },
  invite_invalid: { body: 'That is not an invitation link. Copy it again from the inviting device.' },
  join_ended: { body: 'Not added. It was cancelled, timed out, or the code was used. Try again.' },
  signed_out: { body: 'Signed out. Local sessions and settings are unchanged.' },
  rate_limited: {
    body: 'OpenAgentd is getting too many requests from this network. Try again in a few minutes.',
    tone: 'warning',
  },
  too_many_pending: {
    body: '3 devices are already waiting to join; wait a few minutes or turn them down on a device that can add devices.',
    tone: 'warning',
  },
  device_limit: { body: 'Your account has 10 devices; remove one first.', tone: 'warning' },
  device_exists: { body: 'This device is already in your account or waiting to join. Sign in again to start over.' },
  account_closing: {
    title: 'Account scheduled for deletion.',
    body: 'To keep it, sign in at account.openagentd.dev and choose Keep account, then sign in here again.',
    tone: 'warning',
  },
  account_unavailable: {
    title: 'Account unavailable.',
    body: 'Contact OpenAgentd if this continues. Everything on this device keeps working.',
    tone: 'warning',
  },
  unreachable: { body: "Couldn't reach OpenAgentd. Check your network and try again.", tone: 'warning' },
  wrong_recovery_code: {
    title: "That recovery code doesn't match this account.",
    body: 'Nothing was changed. Check the code you saved and try again.',
    tone: 'warning',
  },
  failed: {
    body: 'Something went wrong while signing in on this device. Sign in again to start over.',
    tone: 'warning',
  },
}

/** `45` → `45 seconds`, `60` → `1 minute`, `600` → `10 minutes`. */
export function waitText(seconds: number): string {
  if (seconds <= 1) return 'a moment'
  if (seconds < 60) return `${Math.round(seconds)} seconds`
  if (seconds < 120) return '1 minute'
  return `${Math.ceil(seconds / 60)} minutes`
}

/** A guest's notice, with the wait the cloud asked for when it said one. */
export function noticeCopy(notice: CloudNotice, retryAfter?: number | null): NoticeCopy {
  const copy = NOTICES[notice]
  if (notice === 'rate_limited' && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return { ...copy, body: `OpenAgentd is getting too many requests from this network. Try again in ${waitText(retryAfter)}.` }
  }
  return copy
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
        Sign in to use your computers from your other devices away from home, and get notified
        when agents finish. It&apos;s optional: everything else works without an account.
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
        page shows the same device ID:{' '}
        <strong className="font-mono text-(--color-text)">{fingerprint}</strong>
      </p>
    </>
  )
}

/** Scan to add: the QR code is the first way; a phone not signed in yet signs in, then adds it. */
export function ScanCodeCopy({ minutes }: { minutes: number }) {
  return (
    <>
      <p className="font-medium text-(--color-text)">Scan with your phone</p>
      <p>
        Open OpenAgentd on your phone. On Computers, tap{' '}
        <strong className="text-(--color-text)">Scan QR code</strong>.
      </p>
      <p>Works for {minutes} minutes. Show it only to your own phone.</p>
    </>
  )
}

export const SCANNED_COPY = 'Your phone scanned this computer. Tap Add on your phone.'
export const PICK_NUMBER = 'Which number is on your phone?'

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

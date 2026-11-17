import type { CloudNotice, CloudPending, CloudStatus } from '@/api/cloud'
import { defineMachine } from '@/lib/machine'

/**
 * What the Remote control page has open besides the account status: the
 * folds, forms, sheets and the sign-out question. Each belongs to one
 * screen, so it lives inside that screen's state and goes when the screen
 * does: a sign-in cancelled back to the signed-out page starts it fresh,
 * and a sheet never outlives the signed-in page it opened on.
 *
 * The screen follows the account status (``status`` events); the rest are
 * the person's moves on that screen.
 */
export type PairingSheet = { kind: 'none' } | { kind: 'add' } | { kind: 'review'; row: CloudPending }

export type PairingUi =
  /** No status yet, or one with nothing to open (unavailable). */
  | { kind: 'none' }
  /** Signed out. ``notice`` is the one last seen, so a new wrong code reopens the form once. */
  | { kind: 'guest'; notice: CloudNotice | null; otherWays: boolean; link: boolean; code: boolean }
  /**
   * A sign-in, join or set-up under way. ``recoveryNext``: the person chose
   * "Lost your phone?" here, so the signed-out page it cancels back to opens
   * on the recovery code.
   */
  | { kind: 'waiting'; step: CloudStatus['state']; browserWay: boolean; recoveryNext: boolean }
  | { kind: 'connected'; sheet: PairingSheet; signOut: boolean }
  | { kind: 'closing'; signOut: boolean }

export type PairingEvent =
  | { type: 'status'; status: CloudStatus }
  | { type: 'otherWays' }
  | { type: 'withLink' }
  | { type: 'withCode'; open: boolean }
  | { type: 'browserWay' }
  | { type: 'recoveryNext' }
  | { type: 'sheet'; sheet: PairingSheet }
  | { type: 'signOut'; open: boolean }

export const PAIRING_NONE: PairingUi = { kind: 'none' }
const NO_SHEET: PairingSheet = { kind: 'none' }

const WAITING_STEPS = new Set<CloudStatus['state']>(['signing_in', 'recovery', 'joining', 'invited', 'scanned', 'confirming'])

/** The screen a status shows; the same screen keeps what it has open. */
function onStatus(ui: PairingUi, status: CloudStatus): PairingUi {
  const state = status.state
  if (state === 'guest') {
    // A wrong recovery code: the form opens again, to try once more.
    const wrongCode = status.notice === 'wrong_recovery_code' && (ui.kind !== 'guest' || ui.notice !== status.notice)
    if (ui.kind === 'guest') {
      if (ui.notice === status.notice) return ui
      return wrongCode ? { ...ui, notice: status.notice, otherWays: true, code: true } : { ...ui, notice: status.notice }
    }
    const toCode = wrongCode || (ui.kind === 'waiting' && ui.recoveryNext)
    return { kind: 'guest', notice: status.notice, otherWays: toCode, link: false, code: toCode }
  }
  if (WAITING_STEPS.has(state)) {
    if (ui.kind === 'waiting') return ui.step === state ? ui : { ...ui, step: state, browserWay: false }
    return { kind: 'waiting', step: state, browserWay: false, recoveryNext: false }
  }
  if (state === 'connected') return ui.kind === 'connected' ? ui : { kind: 'connected', sheet: NO_SHEET, signOut: false }
  // The sign-out question carries over: Sign out is offered on both.
  if (state === 'closing') return ui.kind === 'closing' ? ui : { kind: 'closing', signOut: ui.kind === 'connected' && ui.signOut }
  return ui.kind === 'none' ? ui : PAIRING_NONE
}

export const pairingMachine = defineMachine<PairingUi, PairingEvent>('cloud pairing ui', {
  none: {
    status: (s, e) => onStatus(s, e.status),
    // The sign-out question closes after the account it asked about is gone.
    signOut: (s) => s,
  },
  guest: {
    status: (s, e) => onStatus(s, e.status),
    otherWays: (s) => ({ ...s, otherWays: !s.otherWays }),
    withLink: (s) => ({ ...s, link: true }),
    withCode: (s, e) => ({ ...s, code: e.open }),
    // As above: signing out lands here before the question closes.
    signOut: (s) => s,
  },
  waiting: {
    status: (s, e) => onStatus(s, e.status),
    browserWay: (s) => ({ ...s, browserWay: !s.browserWay }),
    recoveryNext: (s) => ({ ...s, recoveryNext: true }),
  },
  connected: {
    status: (s, e) => onStatus(s, e.status),
    sheet: (s, e) => ({ ...s, sheet: e.sheet }),
    signOut: (s, e) => ({ ...s, signOut: e.open }),
  },
  closing: {
    status: (s, e) => onStatus(s, e.status),
    signOut: (s, e) => ({ ...s, signOut: e.open }),
  },
})

export const pairingStep = (ui: PairingUi, event: PairingEvent): PairingUi => pairingMachine.transition(ui, event)

/** Reads for the page, each false or empty on any other screen. */
export const otherWaysOpen = (ui: PairingUi) => ui.kind === 'guest' && ui.otherWays
export const linkOpen = (ui: PairingUi) => ui.kind === 'guest' && ui.link
export const codeOpen = (ui: PairingUi) => ui.kind === 'guest' && ui.code
export const browserWayOpen = (ui: PairingUi) => ui.kind === 'waiting' && ui.browserWay
export const sheetOf = (ui: PairingUi): PairingSheet => (ui.kind === 'connected' ? ui.sheet : NO_SHEET)
export const signOutAsked = (ui: PairingUi) => (ui.kind === 'connected' || ui.kind === 'closing') && ui.signOut

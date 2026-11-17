import { describe, expect, it } from 'bun:test'
import type { CloudStatus } from '@/api/cloud'
import {
  PAIRING_NONE,
  codeOpen,
  otherWaysOpen,
  pairingMachine,
  pairingStep,
  sheetOf,
  signOutAsked,
  type PairingEvent,
  type PairingUi,
} from '@/components/settings/pages/pairing-ui-state'
import { IllegalTransition } from '@/lib/machine'

const GUEST: CloudStatus = { state: 'guest', notice: null }
const SIGNING_IN: CloudStatus = { state: 'signing_in', user_code: 'A', url: 'https://x', fingerprint: 'f', expires_in: 60 }
const JOINING: CloudStatus = { state: 'joining', fingerprint: 'f', code: null }
const CONNECTED = { state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 } as CloudStatus
const CLOSING = { state: 'closing', fingerprint: 'f', deletes_at: null } as CloudStatus

const run = (events: PairingEvent[], from: PairingUi = PAIRING_NONE) => events.reduce(pairingStep, from)
const status = (s: CloudStatus): PairingEvent => ({ type: 'status', status: s })

const STATES: PairingUi[] = [
  PAIRING_NONE,
  run([status(GUEST)]),
  run([status(SIGNING_IN)]),
  run([status(CONNECTED)]),
  run([status(CLOSING)]),
]
const EVENTS: PairingEvent[] = [
  status(GUEST),
  { type: 'otherWays' },
  { type: 'withLink' },
  { type: 'withCode', open: true },
  { type: 'browserWay' },
  { type: 'recoveryNext' },
  { type: 'sheet', sheet: { kind: 'add' } },
  { type: 'signOut', open: true },
]

describe('cloud pairing ui', () => {
  it('rejects every move the table does not list', () => {
    const listed = new Set(pairingMachine.moves().map(([s, e]) => `${s}/${e}`))
    let rejected = 0
    for (const state of STATES) {
      for (const event of EVENTS) {
        if (listed.has(`${state.kind}/${event.type}`)) continue
        expect(() => pairingMachine.transition(state, event)).toThrow(IllegalTransition)
        rejected++
      }
    }
    expect(rejected).toBeGreaterThan(0)
  })

  it('starts the signed-out page fresh after a sign-in', () => {
    const ui = run([status(GUEST), { type: 'otherWays' }, { type: 'withLink' }, status(SIGNING_IN), status(GUEST)])
    expect(ui).toEqual({ kind: 'guest', notice: null, otherWays: false, link: false, code: false })
  })

  it('opens the recovery code on the signed-out page after "Lost your phone?" on a waiting step', () => {
    const ui = run([status(JOINING), { type: 'recoveryNext' }, status(GUEST)])
    expect(otherWaysOpen(ui)).toBe(true)
    expect(codeOpen(ui)).toBe(true)
  })

  it('reopens the recovery code once per wrong code, so the person can close it', () => {
    const wrong: CloudStatus = { state: 'guest', notice: 'wrong_recovery_code' }
    const opened = run([status(GUEST), status(wrong)])
    expect(codeOpen(opened)).toBe(true)
    const closed = run([{ type: 'withCode', open: false }, status(wrong)], opened)
    expect(codeOpen(closed)).toBe(false)
  })

  it('closes a sheet when the signed-in page goes', () => {
    const ui = run([status(CONNECTED), { type: 'sheet', sheet: { kind: 'add' } }, status(GUEST), status(CONNECTED)])
    expect(sheetOf(ui)).toEqual({ kind: 'none' })
  })

  it('keeps the sign-out question from signed in to closing, and drops it after sign-out', () => {
    const asked = run([status(CONNECTED), { type: 'signOut', open: true }, status(CLOSING)])
    expect(signOutAsked(asked)).toBe(true)
    const gone = run([status(GUEST), { type: 'signOut', open: false }], asked)
    expect(signOutAsked(gone)).toBe(false)
  })

  it('returns the same state for a status that changes nothing, so the page does not re-render', () => {
    const ui = run([status(GUEST), { type: 'otherWays' }])
    expect(pairingStep(ui, status({ state: 'guest', notice: null }))).toBe(ui)
  })
})

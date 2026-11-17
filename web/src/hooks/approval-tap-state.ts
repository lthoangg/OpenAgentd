import type { PendingRow } from '@/api/phone-cloud'
import { defineMachine } from '@/lib/machine'

/**
 * A tap on "A device wants to join your account" (``PhoneCloudSync``):
 * ``tapped`` until the phone's status is known and the newest request is
 * read, then the approval sheet for it. A phone that cannot approve drops
 * the tap, so a later sign-in never opens the sheet by itself.
 */
export type ApprovalTap = { kind: 'none' } | { kind: 'tapped' } | { kind: 'reviewing'; row: PendingRow }

export type ApprovalTapEvent =
  | { type: 'tap' }
  /** This phone cannot approve, or nothing is waiting. */
  | { type: 'drop' }
  | { type: 'found'; row: PendingRow }
  /** The sheet closed. */
  | { type: 'close' }

export const NO_TAP: ApprovalTap = { kind: 'none' }

export const approvalTapMachine = defineMachine<ApprovalTap, ApprovalTapEvent>('join approval', {
  none: { tap: () => ({ kind: 'tapped' }) },
  tapped: {
    // Several taps before the read: one sheet.
    tap: (s) => s,
    drop: () => NO_TAP,
    found: (_, e) => ({ kind: 'reviewing', row: e.row }),
  },
  reviewing: {
    // The open sheet stays on the request it shows.
    tap: (s) => s,
    close: () => NO_TAP,
  },
})

export const approvalTapStep = (s: ApprovalTap, e: ApprovalTapEvent): ApprovalTap => approvalTapMachine.transition(s, e)

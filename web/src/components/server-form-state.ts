import { defineMachine } from '@/lib/machine'

/**
 * The add or edit form of the computer list (``AppBackendPanel``). What it
 * holds (the fields, the last good test, its error, whether it came from a
 * scanned code) lives inside ``open``, so closing the form drops all of it:
 * a scanned computer's note goes once it is connected, and a form opened
 * next starts clean.
 *
 * Replies that land after the form closed (a test, a stored key read) are
 * dropped: the form they were for is gone.
 */
export type ServerFormTarget =
  | { kind: 'add' }
  | { kind: 'edit'; baseUrl: string; label: string; inUse: boolean }

export interface ServerFormValues {
  baseUrl: string
  serverName: string
  accessKey: string
}

export type ServerFormState =
  | { kind: 'closed' }
  | {
      kind: 'open'
      target: ServerFormTarget
      values: ServerFormValues
      /** Filled in from a scanned connect code. */
      scanned: boolean
      /** What the edited server had, so a rename saves without a new test. */
      original: { baseUrl: string; accessKey: string } | null
      /** The normalized address whose last test passed, with the key as typed then. */
      tested: string | null
      /** The form's check or save failed. */
      error: string | null
    }

export type ServerFormEvent =
  | { type: 'open'; target: ServerFormTarget; values: ServerFormValues; scanned?: boolean; original?: { baseUrl: string; accessKey: string } | null }
  /** The edited server's stored key arrived. */
  | { type: 'keyLoaded'; baseUrl: string; accessKey: string }
  | { type: 'input'; field: keyof ServerFormValues; value: string }
  | { type: 'tested'; baseUrl: string }
  /** ``null`` clears it, as a new test starts. */
  | { type: 'error'; error: string | null }
  | { type: 'close' }

export const FORM_CLOSED: ServerFormState = { kind: 'closed' }
/** The fields while no form is open. */
export const NO_VALUES: ServerFormValues = { baseUrl: '', serverName: '', accessKey: '' }

const open = (e: Extract<ServerFormEvent, { type: 'open' }>): ServerFormState => ({
  kind: 'open',
  target: e.target,
  values: e.values,
  scanned: e.scanned ?? false,
  original: e.original ?? null,
  tested: null,
  error: null,
})

export const serverFormMachine = defineMachine<ServerFormState, ServerFormEvent>('server form', {
  closed: {
    open: (_, e) => open(e),
    // Late replies for a form that closed: nothing to show them in.
    keyLoaded: (s) => s,
    tested: (s) => s,
    error: (s) => s,
    // A save or a removal that finishes after the form closed.
    close: (s) => s,
  },
  open: {
    open: (_, e) => open(e),
    keyLoaded: (s, e) =>
      s.target.kind === 'edit' && s.target.baseUrl === e.baseUrl
        ? { ...s, values: { ...s.values, accessKey: e.accessKey }, original: { baseUrl: e.baseUrl, accessKey: e.accessKey } }
        : s,
    // A new address or key needs a new test; a new name does not.
    input: (s, e) => ({ ...s, values: { ...s.values, [e.field]: e.value }, tested: e.field === 'serverName' ? s.tested : null }),
    tested: (s, e) => ({ ...s, tested: e.baseUrl }),
    error: (s, e) => ({ ...s, error: e.error }),
    close: () => FORM_CLOSED,
  },
})

export const serverFormStep = (s: ServerFormState, e: ServerFormEvent): ServerFormState => serverFormMachine.transition(s, e)

export const formTargetOf = (s: ServerFormState): ServerFormTarget | null => (s.kind === 'open' ? s.target : null)

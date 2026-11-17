/**
 * One lifecycle, one state value, one table of moves (``web/src/AGENTS.md``
 * → State machines).
 *
 * A machine is a discriminated union of states (``kind``), a union of
 * events (``type``), and a table: for each state kind, the events it takes
 * and the pure function that makes the next state. The table is the
 * implementation, so there is nothing to keep in step with it. Store the
 * state in one field and change it only through ``transition``; derive
 * every flag (working, busy, show the chip) from it with a selector.
 *
 * - ``can`` answers "may this happen now?", for a refusal that is an
 *   ordinary outcome (Stop when nothing runs).
 * - ``transition`` makes a move. One the table does not list leaves the
 *   state as it was and logs ``illegal_transition``; under test it throws,
 *   so a test catches it. A stale event that is fine to drop is listed as a
 *   move that returns the state unchanged, with a comment saying why.
 * - ``moves`` lists the table, for tests and for reading.
 */

type Kinded = { kind: string }
type Typed = { type: string }

/** For each state kind, the events it takes and the next state each makes. */
export type Transitions<S extends Kinded, E extends Typed> = {
  [K in S['kind']]?: {
    [T in E['type']]?: (state: Extract<S, { kind: K }>, event: Extract<E, { type: T }>) => S
  }
}

export interface Machine<S extends Kinded, E extends Typed> {
  readonly name: string
  transition: (state: S, event: E) => S
  can: (state: S, event: E) => boolean
  /** Every listed move as ``[stateKind, eventType]``. */
  moves: () => Array<[S['kind'], E['type']]>
}

export class IllegalTransition extends Error {
  readonly machine: string
  readonly from: string
  readonly event: string
  constructor(machine: string, from: string, event: string) {
    super(`illegal_transition: ${machine}: ${event} is not allowed in ${from}`)
    this.name = 'IllegalTransition'
    this.machine = machine
    this.from = from
    this.event = event
  }
}

let strict = false
/** Throw on an illegal move instead of logging it. The test setup turns it on. */
export function setStrictMachines(on: boolean): void {
  strict = on
}

export function defineMachine<S extends Kinded, E extends Typed>(name: string, table: Transitions<S, E>): Machine<S, E> {
  type Step = (state: S, event: E) => S
  const handler = (state: S, event: E): Step | undefined =>
    (table as Record<string, Record<string, Step> | undefined>)[state.kind]?.[event.type]
  return {
    name,
    transition(state, event) {
      const step = handler(state, event)
      if (step) return step(state, event)
      const err = new IllegalTransition(name, state.kind, event.type)
      if (strict) throw err
      console.warn('illegal_transition', { machine: name, from: state.kind, event: event.type })
      return state
    },
    can: (state, event) => handler(state, event) !== undefined,
    moves: () =>
      Object.entries(table as Record<string, Record<string, Step> | undefined>).flatMap(([kind, events]) =>
        Object.keys(events ?? {}).map((type) => [kind, type] as [S['kind'], E['type']]),
      ),
  }
}

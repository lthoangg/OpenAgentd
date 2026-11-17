import { defineMachine } from '@/lib/machine'

/**
 * The `/btw` answer streaming in this tab (``useBtwStore``). It streams,
 * then ends once: done, stopped or failed. An ended answer stays as it
 * ended: a Stop that crossed its last event, or a stream that broke after
 * it, changes nothing.
 */
interface BtwAnswerBase {
  /** Server id, known from ``btw_start`` on. */
  id: string | null
  question: string
  text: string
}
export type BtwLive =
  | (BtwAnswerBase & { kind: 'streaming' })
  | (BtwAnswerBase & { kind: 'done' })
  | (BtwAnswerBase & { kind: 'stopped' })
  | (BtwAnswerBase & { kind: 'error'; error: string })

export type BtwAnswerEvent =
  /** ``btw_start``: also sent when a retry restarts the answer. */
  | { type: 'start'; id: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string }
  /** ``btw_error``: the server ended it, with what was written so far. */
  | { type: 'ended'; status: 'error' | 'stopped'; message: string; answer: string }
  /** The request failed here. */
  | { type: 'failed'; message: string }
  /** Stopped from this tab. */
  | { type: 'stop' }

export const streamingAnswer = (question: string): BtwLive => ({ kind: 'streaming', id: null, question, text: '' })

const base = ({ id, question, text }: BtwLive): BtwAnswerBase => ({ id, question, text })
// An ended answer keeps how it ended (see above).
const keep = (s: BtwLive): BtwLive => s
const ENDED = { stop: keep, failed: keep }

export const btwAnswerMachine = defineMachine<BtwLive, BtwAnswerEvent>('btw answer', {
  streaming: {
    start: (s, e) => ({ ...s, id: e.id, text: '' }),
    delta: (s, e) => ({ ...s, text: s.text + e.text }),
    done: (s, e) => ({ ...base(s), kind: 'done', text: e.answer }),
    ended: (s, e) =>
      e.status === 'error'
        ? { ...base(s), kind: 'error', text: e.answer, error: e.message }
        : { ...base(s), kind: 'stopped', text: e.answer },
    failed: (s, e) => ({ ...base(s), kind: 'error', error: e.message }),
    stop: (s) => ({ ...base(s), kind: 'stopped' }),
  },
  done: ENDED,
  stopped: ENDED,
  error: ENDED,
})

export const btwErrorOf = (live: BtwLive): string | null => (live.kind === 'error' ? live.error : null)

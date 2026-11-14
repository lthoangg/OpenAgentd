/**
 * A failure toast reads as a sentence. Text the server wrote for people
 * ("Approve the plan first…") stays on the toast; the machine's words (a
 * status line, JSON, a stack) go behind Copy details, as on the crash
 * screens, and the second line says what to do instead.
 */
import { useToastStore, type Toast } from '@/stores/useToastStore'

const NEXT_STEP = 'Try again, or copy the details for a bug report.'

// What no person wrote for a person: a status line, JSON or markup, an
// identifier, a stack frame, the browser's own fetch errors ("… to fetch",
// "Load failed"), several lines.
const MACHINE_TEXT = /failed: \d{3}$|^HTTP \d{3}|[{}<>]|\b[a-z0-9]+_[a-z0-9_]+\b|\bat \S+:\d+| to fetch$|^Load failed$|NetworkError|^[A-Z][A-Za-z]*Error:|\n/

function readsAsSentence(text: string): boolean {
  return text.length <= 160 && text.includes(' ') && !MACHINE_TEXT.test(text)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.trim()
  return typeof err === 'string' ? err.trim() : ''
}

function details(title: string, err: unknown, text: string): string {
  const lines = [title, text]
  if (err && typeof err === 'object') {
    const { status, detail } = err as { status?: unknown; detail?: unknown }
    if (typeof status === 'number') lines.push(`Status: ${status}`)
    if (detail && typeof detail === 'object') lines.push(JSON.stringify(detail))
  }
  return lines.join('\n')
}

/**
 * The error's own words when they read as a sentence, for a toast whose one
 * button is already taken (Retry).
 */
export function failureSentence(err: unknown): string | undefined {
  const text = errorText(err)
  return text && readsAsSentence(text) ? text : undefined
}

/**
 * ``cause`` is the sentence a caller writes when it knows why this failed;
 * without one, a sentence in the error is shown and anything else is not.
 */
export function failureToast(title: string, err: unknown, cause?: string): Omit<Toast, 'id'> {
  const text = errorText(err)
  if (!text) return cause ? { tone: 'error', title, description: cause } : { tone: 'error', title }
  if (!cause && readsAsSentence(text)) return { tone: 'error', title, description: text }
  const copy = details(title, err, text)
  return {
    tone: 'error',
    title,
    description: cause ?? NEXT_STEP,
    action: { label: 'Copy details', onAction: () => { void navigator.clipboard?.writeText(copy).catch(() => {}) } },
  }
}

/** Pushes ``failureToast``; returns the toast id. */
export function pushFailureToast(title: string, err: unknown, cause?: string): string {
  return useToastStore.getState().push(failureToast(title, err, cause))
}

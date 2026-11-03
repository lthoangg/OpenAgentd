/**
 * Composer insert requests: a window event that asks the chat composer to
 * append text to the current draft, so a surface that cannot reach the
 * composer's ref (the terminal in the Review dock) can still add to it.
 * ``useSessionBootstrap`` listens, appends as its own paragraph (never
 * replacing what the user typed) and focuses the composer.
 */

export const COMPOSER_INSERT_EVENT = 'composer:insert'

/** Ask the composer of the open session to append ``text`` to its draft. */
export function requestComposerInsert(text: string): void {
  if (!text) return
  window.dispatchEvent(new CustomEvent<{ text: string }>(COMPOSER_INSERT_EVENT, { detail: { text } }))
}

/** Listen for insert requests; returns the unsubscribe function. */
export function onComposerInsert(handler: (text: string) => void): () => void {
  const listener = (event: Event) => {
    const text = (event as CustomEvent<{ text?: string }>).detail?.text
    if (text) handler(text)
  }
  window.addEventListener(COMPOSER_INSERT_EVENT, listener)
  return () => window.removeEventListener(COMPOSER_INSERT_EVENT, listener)
}

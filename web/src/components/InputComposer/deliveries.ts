/**
 * The three ways to send while a turn runs, named once: the desktop's
 * chevron menu and the phone's long-press sheet show the same words.
 */

/**
 * How a message sent during a turn is delivered: ``steer`` hands it to the
 * running turn before the agent's next step, ``after-turn`` holds it until
 * the turn ends, ``interrupt`` stops the turn and sends it in its place.
 * Idle sends are always ``steer``, which simply starts a turn.
 */
export type SendDelivery = 'steer' | 'after-turn' | 'interrupt'

/** Either primary modifier stops and sends, so a Mac user reaching for Ctrl is not surprised. */
export function deliveryForKey(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): SendDelivery {
  if (e.metaKey || e.ctrlKey) return 'interrupt'
  if (e.altKey) return 'after-turn'
  return 'steer'
}

export const DELIVERIES: ReadonlyArray<{ id: SendDelivery; label: string; hint: string }> = [
  { id: 'steer', label: 'Steer', hint: 'Send now, read before the next step' },
  { id: 'after-turn', label: 'Queue until done', hint: 'Sends when this turn ends' },
  { id: 'interrupt', label: 'Stop and send', hint: 'Stops this turn, then sends' },
]

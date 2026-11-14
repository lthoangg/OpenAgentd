/**
 * The three ways to send while a turn runs, named once: the desktop's
 * chevron menu and the phone's long-press sheet show the same words.
 */
import type { SendDelivery } from './InputComposer'

export const DELIVERIES: ReadonlyArray<{ id: SendDelivery; label: string; hint: string }> = [
  { id: 'steer', label: 'Steer', hint: 'Send now, read before the next step' },
  { id: 'after-turn', label: 'Queue until done', hint: 'Sends when this turn ends' },
  { id: 'interrupt', label: 'Stop and send', hint: 'Stops this turn, then sends' },
]

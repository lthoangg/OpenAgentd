import type { KeyboardEvent } from 'react'
import { hasFinePointer } from '@/lib/pointer'

const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button'

/**
 * On a touch keyboard, Enter in a single-line field moves to the next field
 * instead of submitting the form (Enter is the keyboard's "Next" key; an
 * accidental submit mid-form is worse than one more tap). Only the submit
 * button submits. With a mouse or trackpad, Enter submits as before.
 *
 * Attach to the `<form>`'s `onKeyDown`. Textareas, buttons and key events from
 * portalled popovers (which bubble through React but aren't inside the form
 * DOM) are left alone.
 */
export function advanceFocusOnEnter(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.defaultPrevented) return
  if (hasFinePointer()) return
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const form = event.currentTarget
  if (!form.contains(target)) return
  if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(target.type)) return

  event.preventDefault()
  const fields = Array.from(form.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !(el as HTMLInputElement).disabled && el.tabIndex !== -1,
  )
  fields[fields.indexOf(target) + 1]?.focus()
}

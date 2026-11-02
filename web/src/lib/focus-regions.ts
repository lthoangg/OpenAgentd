/**
 * F6 / ⇧F6: move focus between the window's areas, as in native apps and
 * editors: sidebar → transcript → composer → Review panel (each pane, left
 * to right and top to bottom) → status bar, and around.
 *
 * An area is an element marked ``data-focus-region="<name>"``. Hidden,
 * inert or absent areas are skipped. Areas of one name go by their
 * ``data-focus-order`` (Review panel panes sit in the DOM in the order they
 * were made, not where they are). Entering an area focuses, in order:
 * the element focused there last (still inside and focusable), the one
 * marked ``data-region-entry``, the current item (``aria-current``: the
 * open session, a pane's active tab), its first focusable control, or the
 * area itself (made focusable with ``tabindex=-1``). An area marked
 * ``data-region-self`` (the transcript) takes focus itself unless focus was
 * in it before, so the arrow and page keys scroll it.
 */
import type { KeyChord } from '@/lib/keyboard/chord'

export const FOCUS_REGIONS = ['sidebar', 'transcript', 'composer', 'dock', 'status'] as const
export type FocusRegion = (typeof FOCUS_REGIONS)[number]

export const REGION_ATTR = 'data-focus-region'

export const NEXT_REGION_CHORD: KeyChord = { key: 'F6' }
export const PREV_REGION_CHORD: KeyChord = { key: 'F6', shift: true }

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Last focused element per area, kept while it stays in the document. */
const lastFocused = new WeakMap<Element, HTMLElement>()

function isShown(el: Element): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true })
  // Older WebKit: walk up for display:none / visibility:hidden.
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

function canFocus(el: HTMLElement | null | undefined, region: Element): el is HTMLElement {
  return !!el && el.isConnected && region.contains(el) && isShown(el) && !(el as HTMLButtonElement).disabled
}

/** The areas on screen, in cycle order. */
export function visibleRegions(root: ParentNode = document): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(`[${REGION_ATTR}]`)).filter(isShown)
  const rank = (el: HTMLElement) => {
    const index = FOCUS_REGIONS.indexOf(el.getAttribute(REGION_ATTR) as FocusRegion)
    return index < 0 ? FOCUS_REGIONS.length : index
  }
  const order = (el: HTMLElement) => Number(el.getAttribute('data-focus-order')) || 0
  return found.sort((a, b) => rank(a) - rank(b) || order(a) - order(b))
}

/** Remember where focus is inside its area, to come back there. */
export function rememberRegionFocus(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return
  const region = target.closest(`[${REGION_ATTR}]`)
  if (region && target !== region) lastFocused.set(region, target)
}

/** Focus inside ``region``; returns the element focused. */
export function enterRegion(region: HTMLElement): HTMLElement {
  const remembered = lastFocused.get(region)
  if (region.hasAttribute('data-region-self') && !canFocus(remembered, region)) return focusSelf(region)
  const marked = region.querySelector<HTMLElement>('[data-region-entry]')
  const current = region.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"]')
  const first = Array.from(region.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => canFocus(el, region))
  const target = [remembered, marked, current, first].find((el) => canFocus(el, region))
  if (target) {
    target.focus()
    return target
  }
  return focusSelf(region)
}

function focusSelf(region: HTMLElement): HTMLElement {
  if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1')
  region.focus()
  return region
}

/** Move to the next (``1``) or previous (``-1``) area; null when there is none. */
export function cycleRegion(delta: 1 | -1, root: ParentNode = document): HTMLElement | null {
  const regions = visibleRegions(root)
  if (regions.length === 0) return null
  const active = document.activeElement
  const current = active ? regions.findIndex((region) => region.contains(active)) : -1
  const next = current < 0
    ? (delta === 1 ? 0 : regions.length - 1)
    : (current + delta + regions.length) % regions.length
  return enterRegion(regions[next])
}

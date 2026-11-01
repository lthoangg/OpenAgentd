/**
 * A Comment action on every paragraph, list item and heading of the plan, so a
 * comment is one click instead of select-then-Comment.
 *
 * The plan is rendered by the shared Markdown renderer, which knows nothing of
 * review, so each commentable block gets a small slot appended to it (marked as
 * an overlay, so it is never plan text) and the button renders into that slot
 * through a portal. The slot lives inside the block, which lets plain CSS do
 * the reveal: with a mouse the action shows while the block is hovered or has
 * focus inside it; on touch it sits at the end of the block at rest, since
 * there is no hover. At rest with a mouse it is only transparent, never
 * ``display: none`` or hidden, so Tab still reaches it and focus shows it.
 * Slots are re-synced when the rendered plan changes.
 *
 * The visible word "Comment" is drawn by CSS (``content``), not written into
 * the page, so it never becomes part of the plan text: a selection, a copy and
 * a comment's quote all see only the plan. The button's name is its aria-label.
 */
import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquarePlus } from 'lucide-react'

import { PLAN_OVERLAY_ATTR } from './plan-comments'

const SLOT_ATTR = 'data-plan-slot'
/** Blocks a comment can be about; code, diagrams and tables are not. */
const COMMENTABLE = 'p, li, h1, h2, h3, h4, h5, h6'
const BLOCK_CLASSES = ['group/block', 'relative']
/** The slot adds nothing to the text: the button positions against the block. */
const SLOT_CLASS = 'select-none'

export interface BlockSlot {
  id: string
  slot: HTMLElement
  /** The block's own text, whitespace collapsed. */
  quote: string
}

let slotCounter = 0

function isList(el: Element): boolean {
  return el.tagName === 'UL' || el.tagName === 'OL'
}

/** The block's own text: not the slot's, and not a nested list's (its items have their own). */
export function blockText(block: HTMLElement): string {
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.hasAttribute(PLAN_OVERLAY_ATTR)) return
    if (el !== block && isList(el)) return
    el.childNodes.forEach(walk)
  }
  walk(block)
  return text.replace(/\s+/g, ' ').trim()
}

/** A list item that wraps paragraphs (a loose list) leaves the comment to them. */
function wrapsBlocks(li: HTMLElement): boolean {
  return Array.from(li.children).some((child) => child.matches('p, h1, h2, h3, h4, h5, h6'))
}

export function commentableBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(COMMENTABLE)).filter((el) => {
    if (el.closest(`[${PLAN_OVERLAY_ATTR}]`) || el.closest('table')) return false
    if (el.tagName === 'LI' && wrapsBlocks(el)) return false
    return blockText(el) !== ''
  })
}

function slotOf(block: HTMLElement): HTMLElement | null {
  return Array.from(block.children).find((child): child is HTMLElement => child.hasAttribute(SLOT_ATTR)) ?? null
}

function sameSlots(a: readonly BlockSlot[], b: readonly BlockSlot[]): boolean {
  return a.length === b.length && a.every((item, i) => item.slot === b[i]?.slot && item.quote === b[i]?.quote)
}

/**
 * Give every commentable block in ``bodyRef`` a slot while ``enabled``, and
 * take them all away again when it is not.
 */
export function usePlanBlockSlots(bodyRef: RefObject<HTMLElement | null>, enabled: boolean): BlockSlot[] {
  const [slots, setSlots] = useState<BlockSlot[]>([])

  useEffect(() => {
    const body = bodyRef.current
    if (!enabled || !body) {
      setSlots((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const marked = new Set<HTMLElement>()
    let frame = 0
    const sync = () => {
      frame = 0
      const next: BlockSlot[] = []
      for (const block of commentableBlocks(body)) {
        let slot = slotOf(block)
        if (!slot) {
          slot = document.createElement('span')
          slot.setAttribute(SLOT_ATTR, '')
          slot.setAttribute(PLAN_OVERLAY_ATTR, '')
          slot.className = SLOT_CLASS
          slotCounter += 1
          slot.dataset.slotId = String(slotCounter)
          // After the block's own text, ahead of any nested list: on touch the action
          // sits inline there, and a nested item has its own.
          const nested = Array.from(block.children).find(isList)
          if (nested) nested.before(slot)
          else block.append(slot)
          block.classList.add(...BLOCK_CLASSES)
          marked.add(block)
        }
        next.push({ id: slot.dataset.slotId ?? '', slot, quote: blockText(block) })
      }
      setSlots((prev) => (sameSlots(prev, next) ? prev : next))
    }
    sync()
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(sync)
    })
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      body.querySelectorAll(`[${SLOT_ATTR}]`).forEach((slot) => slot.remove())
      for (const block of marked) block.classList.remove(...BLOCK_CLASSES)
    }
  }, [bodyRef, enabled])

  return slots
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** The Comment action of every block, drawn into its slot. */
export function PlanBlockComments({ slots, onComment }: { slots: readonly BlockSlot[]; onComment: (quote: string) => void }) {
  return (
    <>
      {slots.map(({ id, slot, quote }) =>
        createPortal(
          <button
            type="button"
            aria-label={`Comment on: ${truncate(quote, 48)}`}
            // Keep a selection the reader is making.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onComment(quote)}
            // Never hidden: at rest a dimmed icon in the block's corner, so a
            // long plan is not a column of buttons; over or inside the block
            // it becomes the full "Comment" pill. Touch always shows the pill.
            className="absolute top-0 right-0 z-10 inline-flex h-6 items-center gap-1 rounded-xs bg-(--bg-key) px-1.5 text-meta font-medium whitespace-nowrap text-(--color-text-muted) transition-[color,opacity,background-color] duration-(--motion-instant) hover:text-(--color-text) pointer-fine:bg-transparent pointer-fine:opacity-60 pointer-fine:group-hover/block:bg-(--bg-key) pointer-fine:group-hover/block:opacity-100 pointer-fine:group-focus-within/block:bg-(--bg-key) pointer-fine:group-focus-within/block:opacity-100 pointer-coarse:static pointer-coarse:ml-2 pointer-coarse:h-9 pointer-coarse:px-2.5"
          >
            <MessageSquarePlus size={11} aria-hidden="true" />
            <span aria-hidden="true" className="after:content-['Comment'] pointer-fine:hidden pointer-fine:group-hover/block:inline pointer-fine:group-focus-within/block:inline" />
          </button>,
          slot,
          id,
        ),
      )}
    </>
  )
}

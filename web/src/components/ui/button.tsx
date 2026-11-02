/**
 * Button — OpenAgentd's own primitive.
 *
 * Fills, not borders (DESIGN.md → Components): the primary action is a solid
 * theme-accent fill (Bark), a secondary one the keycap wash, ghost text only.
 * No variant draws a border, so nothing nests a ring inside a ring.
 *
 * No Radix, no base-ui, no cva. Plain <button> + variant maps + CSS tokens.
 */
import { type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

// ─── Variant maps ─────────────────────────────────────────────────────────────

const BASE = [
  'inline-flex shrink-0 items-center justify-center gap-1.5',
  'font-medium whitespace-nowrap select-none cursor-pointer',
  'transition-[color,background-color,box-shadow,opacity] duration-(--motion-instant) ease-(--ease-in-out) focus-visible:outline-none',
  'focus-visible:ring-2 focus-visible:ring-(--focus-ring)',
  'disabled:cursor-not-allowed disabled:opacity-50',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  "[&_svg:not([class*='size-'])]:size-3.5",
].join(' ')

// Hover steps one tone along the ramp: darker on paper, lighter on dark paper.
const KEY_HOVER = 'hover:bg-(--color-border-subtle) dark:hover:bg-(--color-border) active:bg-(--color-border-subtle) dark:active:bg-(--color-border)'

const VARIANT = {
  default: [
    'bg-(--bg-key)',
    'text-(--color-text)',
    KEY_HOVER,
  ].join(' '),
  subtle: [
    'bg-(--bg-key)',
    'text-(--color-text-muted)',
    'hover:text-(--color-text-2)',
    KEY_HOVER,
  ].join(' '),
  primary: [
    'bg-(--color-accent)',
    'text-(--color-text-on-accent)',
    'hover:bg-(--color-accent)/90',
    'active:bg-(--color-accent)/80',
  ].join(' '),
  ghost: [
    'bg-transparent',
    'text-(--color-text-muted)',
    'hover:bg-(--bg-key)/50 hover:text-(--color-text)',
    'active:bg-(--bg-key)/70',
  ].join(' '),
  danger: [
    'bg-(--color-error-subtle)',
    'text-(--color-error)',
    'hover:bg-(--color-error)/20',
    'active:bg-(--color-error)/20',
  ].join(' '),
  'danger-subtle': [
    'bg-transparent',
    'text-(--color-error)',
    'hover:bg-(--color-error-subtle)',
    'active:bg-(--color-error)/15',
  ].join(' '),
  link: [
    'bg-transparent',
    'text-(--color-text) underline decoration-(--color-border-strong) underline-offset-4',
    'hover:decoration-current',
  ].join(' '),
} as const

// Corner radius follows the app's --radius-* scale (index.css @theme) rather
// than bare Tailwind `rounded` (which is an un-themed 4px default that drifts
// from every hand-rolled icon button in the app, most of which use rounded-md
// /rounded-sm). xs/icon-xs use radius-xs, sm/icon-sm use radius-sm, everything
// else uses radius-md — matching the most common hand-rolled icon-button radius.
const SIZE = {
  xs:       'h-6 px-2 text-meta rounded-xs gap-1',
  trigger:  'px-2 py-1 text-xs rounded-md gap-1.5',
  sm:       'h-8 px-2.5 text-xs rounded-sm',
  default:  'h-9 px-3 text-xs rounded-md',
  lg:       'h-10 px-4 text-sm rounded-md',
  icon:     'size-9 p-0 rounded-md',
  'icon-xs':'size-6 p-0 rounded-xs',
  'icon-sm':'size-8 p-0 rounded-sm',
  // 28px desktop-dense icon action (panel headers, detail panes). Touch still
  // gets the 36px coarse-pointer floor like every other Button (index.css).
  'icon-dense': 'size-7 p-0 rounded-sm',
} as const

// ─── buttonVariants helper (kept for external consumers) ─────────────────────

interface ButtonVariantOptions {
  variant?: keyof typeof VARIANT | null
  size?: keyof typeof SIZE | null
  className?: string
}

function buttonVariants({ variant = 'default', size = 'default', className }: ButtonVariantOptions = {}): string {
  return cn(BASE, VARIANT[variant ?? 'default'], SIZE[size ?? 'default'], className)
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: keyof typeof VARIANT
  size?: keyof typeof SIZE
}

function Button({ className, variant = 'default', size = 'default', ref, ...props }: ButtonProps) {
  return (
    <button
      ref={ref}
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants } // eslint-disable-line react-refresh/only-export-components
export type { ButtonProps }

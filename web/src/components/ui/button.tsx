/**
 * Button — OpenAgentd's own primitive.
 *
 * Design language lifted from the "Cancel" button in AppBackendDialog:
 *   warm paper surface · crisp 1px border · muted text · key-press hover
 *
 * No Radix, no base-ui, no cva. Plain <button> + variant maps + CSS tokens.
 */
import { type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

// ─── Variant maps ─────────────────────────────────────────────────────────────

const BASE = [
  'inline-flex shrink-0 items-center justify-center gap-1.5',
  'rounded border font-medium whitespace-nowrap select-none',
  'transition-colors focus-visible:outline-none',
  'focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
  'disabled:cursor-not-allowed disabled:opacity-50',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  "[&_svg:not([class*='size-'])]:size-3.5",
].join(' ')

const VARIANT: Record<string, string> = {
  default: [
    'border-(--color-border) bg-(--bg-card)',
    'text-(--color-text)',
    'hover:bg-(--bg-key)/25',
    'active:bg-(--bg-key)/50',
  ].join(' '),
  subtle: [
    'border-(--color-border) bg-(--bg-card)',
    'text-(--color-text-muted)',
    'hover:text-(--color-text-2) hover:bg-(--bg-key)/20',
    'active:bg-(--bg-key)/40',
  ].join(' '),
  primary: [
    'border-(--color-border-strong) bg-(--bg-key)',
    'text-(--color-text)',
    'hover:bg-(--color-surface-2) hover:border-(--color-border-strong)',
    'active:bg-(--color-surface-2)/80',
  ].join(' '),
  ghost: [
    'border-transparent bg-transparent',
    'text-(--color-text-muted)',
    'hover:bg-(--bg-key)/40 hover:text-(--color-text)',
    'active:bg-(--bg-key)/70',
  ].join(' '),
  danger: [
    'border-(--color-error)/20 bg-(--color-error-subtle)',
    'text-(--color-error)',
    'hover:bg-(--color-error)/15 hover:border-(--color-error)/35',
    'active:bg-(--color-error)/20',
  ].join(' '),
  'danger-subtle': [
    'border-(--color-border) bg-(--bg-card)',
    'text-(--color-error)',
    'hover:bg-(--color-error)/10 hover:border-(--color-error)/25',
    'active:bg-(--color-error)/15',
  ].join(' '),
  link: [
    'border-transparent bg-transparent',
    'text-(--accent-blue-text) underline-offset-4',
    'hover:underline',
  ].join(' '),
}

const SIZE: Record<string, string> = {
  xs:       'h-6 px-2 text-[10.5px] rounded-[4px] gap-1',
  trigger:  'px-2 py-1 text-xs rounded gap-1.5',
  sm:       'h-8 px-2.5 text-[0.8rem] rounded',
  default:  'h-9 px-3 text-xs rounded',
  lg:       'h-10 px-4 text-sm rounded',
  icon:     'size-9 p-0 rounded',
  'icon-xs':'size-6 p-0 rounded-[4px]',
  'icon-sm':'size-8 p-0 rounded',
}

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
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants } // eslint-disable-line react-refresh/only-export-components
export type { ButtonProps }

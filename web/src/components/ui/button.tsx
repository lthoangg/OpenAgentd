/**
 * Button — OpenAgentd's own primitive.
 *
 * Design language lifted from the "Cancel" button in AppBackendDialog:
 *   warm paper surface · crisp 1px border · muted text · key-press hover
 *
 * No Radix, no base-ui. Plain <button> + cva variants + CSS tokens.
 */
import { type ComponentPropsWithRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// ─── Variants ────────────────────────────────────────────────────────────────

const buttonVariants = cva(
  // ── Base ── the Cancel-button DNA
  [
    'inline-flex shrink-0 items-center justify-center gap-1.5',
    'rounded border font-medium whitespace-nowrap select-none',
    'transition-colors focus-visible:outline-none',
    'focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
    'disabled:cursor-not-allowed disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    "[&_svg:not([class*='size-'])]:size-3.5",
  ],
  {
    variants: {
      /**
       * Visual weight:
       *  default   — paper card surface, visible border          (Cancel, Save)
       *  primary   — dark ink fill, inverted text                (Connect, confirm)
       *  ghost     — no border, no background until hover        (toolbar actions)
       *  danger    — error-tinted surface, red text              (Remove, Stop)
       *  link      — text-only, underline on hover               (inline links)
       */
      variant: {
        default: [
          'border-(--color-border) bg-(--bg-card)',
          'text-(--color-text)',
          'hover:bg-(--bg-key)/25',
          'active:bg-(--bg-key)/50',
        ],
        // Muted at rest, barely lifts on hover — the "connect / edit / use builtin" chip
        subtle: [
          'border-(--color-border) bg-(--bg-card)',
          'text-(--color-text-muted)',
          'hover:text-(--color-text-2) hover:bg-(--bg-key)/20',
          'active:bg-(--bg-key)/40',
        ],
        primary: [
          'border-(--color-border-strong) bg-(--bg-key)',
          'text-(--color-text)',
          'hover:bg-(--color-surface-2) hover:border-(--color-border-strong)',
          'active:bg-(--color-surface-2)/80',
        ],
        ghost: [
          'border-transparent bg-transparent',
          'text-(--color-text-muted)',
          'hover:bg-(--bg-key)/40 hover:text-(--color-text)',
          'active:bg-(--bg-key)/70',
        ],
        // Full error surface at rest — destructive confirm dialogs
        danger: [
          'border-(--color-error)/20 bg-(--color-error-subtle)',
          'text-(--color-error)',
          'hover:bg-(--color-error)/15 hover:border-(--color-error)/35',
          'active:bg-(--color-error)/20',
        ],
        // Plain card surface at rest, red text — the "remove / stop" inline chip
        'danger-subtle': [
          'border-(--color-border) bg-(--bg-card)',
          'text-(--color-error)',
          'hover:bg-(--color-error)/10 hover:border-(--color-error)/25',
          'active:bg-(--color-error)/15',
        ],
        link: [
          'border-transparent bg-transparent',
          'text-(--accent-blue-text) underline-offset-4',
          'hover:underline',
        ],
      },

      size: {
        // inline / dense — matches the dialog row buttons (connect, edit, remove)
        xs:   'h-6 px-2 text-[10.5px] rounded-[4px] gap-1',
        // natural-height trigger — px-2 py-1 text-xs, no fixed h — matches dropdown triggers, search inputs
        trigger: 'px-2 py-1 text-xs rounded gap-1.5',
        // the "Cancel" / "Save server" button size
        sm:   'h-8 px-2.5 text-[0.8rem] rounded',
        // standard form action
        default: 'h-9 px-3 text-xs rounded',
        // prominent / hero action
        lg:   'h-10 px-4 text-sm rounded',
        // square icon-only
        icon: 'size-9 p-0 rounded',
        'icon-xs': 'size-6 p-0 rounded-[4px]',
        'icon-sm': 'size-8 p-0 rounded',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

// ─── Component ────────────────────────────────────────────────────────────────

interface ButtonProps
  extends ComponentPropsWithRef<'button'>,
    VariantProps<typeof buttonVariants> {}

function Button({ className, variant, size, ref, ...props }: ButtonProps) {
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

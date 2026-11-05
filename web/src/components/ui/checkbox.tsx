import { type ComponentPropsWithRef } from 'react'

import { cn } from '@/lib/utils'

interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** Called with the next checked state. */
  onCheckedChange?: (checked: boolean) => void
  checkClassName?: string
}

/**
 * Checkbox — a native ``<input type="checkbox">`` drawn as a box, with the
 * tick as an SVG polyline that is drawn on (and undrawn) by CSS alone: no
 * state, just the ``peer`` pattern. Checking fills the box at ``fast`` and
 * draws the tick at ``base`` after a 60ms beat; unchecking undraws it at
 * ``fast``. The box dips (``scale`` at ``instant``) while pressed, desktop
 * pointer included: it is a small control. Reduced motion snaps (index.css).
 */
function Checkbox({ className, onChange, onCheckedChange, checkClassName, ...props }: CheckboxProps) {
  return (
    <span className="relative inline-flex size-[18px] shrink-0">
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          'peer size-[18px] appearance-none rounded-sm border-[1.5px] border-(--color-text-subtle) bg-(--bg-page) outline-none',
          // Fill and edge crossfade at ``fast``; the press dip is ``instant``.
          'transition-[background-color,border-color,scale] [transition-duration:var(--motion-fast),var(--motion-fast),var(--motion-instant)] ease-(--ease-out)',
          'enabled:active:scale-90',
          'checked:border-(--color-accent) checked:bg-(--color-accent)',
          'focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
        onChange={(event) => {
          onCheckedChange?.(event.currentTarget.checked)
          onChange?.(event)
        }}
        {...props}
      />
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        data-slot="checkbox-check"
        className={cn(
          'pointer-events-none absolute inset-0 m-auto size-3 text-(--color-text-on-accent)',
          // Checked: draw on at ``base`` (``ease-out``) after a short beat.
          'peer-checked:[&>polyline]:[stroke-dashoffset:0] peer-checked:[&>polyline]:delay-60',
          'peer-checked:[&>polyline]:duration-(--motion-base) peer-checked:[&>polyline]:ease-(--ease-out)',
          checkClassName,
        )}
      >
        {/* The tick is ~12.4 units long: a 13-unit dash hidden by its offset until checked. */}
        <polyline
          points="2 6.5 5 9.5 10 3"
          className="fill-none stroke-current stroke-[2.5] [stroke-dasharray:13] [stroke-dashoffset:13] [stroke-linecap:round] [stroke-linejoin:round] transition-[stroke-dashoffset] duration-(--motion-fast) ease-(--ease-in-out)"
        />
      </svg>
    </span>
  )
}

export { Checkbox }

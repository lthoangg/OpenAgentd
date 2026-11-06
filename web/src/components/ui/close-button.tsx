/**
 * CloseButton — the one × (DESIGN.md → Rulebook 6). One per surface, top
 * right: a ghost icon button with a 14px glyph, named "Close" with the
 * tooltip "Close (Esc)". `icon-sm` (32px) on overlay, dialog and panel
 * headers; `icon-xs` (24px) inside a row or a toast, where the touch floor
 * still widens the target.
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface CloseButtonProps extends Omit<ButtonProps, 'variant' | 'size' | 'children'> {
  size?: 'icon-sm' | 'icon-xs' | 'icon-dense'
  /** Accessible name; say what closes when "Close" alone is unclear ("Remove attachment"). */
  label?: string
  /** Tooltip text; `null` for none (inside a surface that already shows one). */
  tooltip?: ReactNode | null
}

export function CloseButton({ size = 'icon-sm', label = 'Close', tooltip = 'Close (Esc)', type = 'button', ...props }: CloseButtonProps) {
  const button = (
    <Button type={type} variant="ghost" size={size} aria-label={label} data-close-button="" {...props}>
      <X size={14} aria-hidden="true" />
    </Button>
  )
  if (tooltip === null) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

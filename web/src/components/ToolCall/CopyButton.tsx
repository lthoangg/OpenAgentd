import { Check, Copy } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { cn } from '@/lib/utils'

/**
 * The transcript's one Copy control (code blocks, tool sections): a muted
 * icon in the block or section header, 24px (36px on touch), always visible.
 * The wash on hover steps one tone along the ramp because the headers it
 * sits in are already keycap-coloured.
 */
export const COPY_BUTTON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--color-fill-key-hover) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:size-9'

interface CopyButtonProps {
  /** What it copies, as an action and a noun: "Copy code", "Copy output". */
  label: string
  /** The text, or a function that builds it when pressed. */
  text: string | (() => string)
  className?: string
}

export function CopyButton({ label, text, className }: CopyButtonProps) {
  const { copied, copy } = useCopyFeedback()
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              onClick={(event) => {
                event.stopPropagation()
                void copy(typeof text === 'function' ? text() : text)
              }}
              className={cn(COPY_BUTTON_CLASS, className)}
            >
              {copied ? (
                <Check size={12} className="text-(--accent-green-text)" aria-hidden />
              ) : (
                <Copy size={12} aria-hidden />
              )}
            </button>
          }
        />
        <TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
      </Tooltip>
      {/* The button keeps its name; the result is announced from here. */}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  )
}

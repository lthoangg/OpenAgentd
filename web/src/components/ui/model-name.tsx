/**
 * A model as every surface shows it (DESIGN.md, "One name per thing"):
 * `provider:model` in mono. When space runs out the `provider:` part gives
 * way first, whole, and the model part truncates last; the full ID is the
 * app tooltip (never a native title).
 */
import type { HTMLAttributes } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { splitModelId } from '@/lib/run-settings'
import { cn } from '@/lib/utils'

/**
 * The `provider:model` line (add `flex` or `inline-flex`). A truncating
 * provider part showed a sliver of its first letter when squeezed
 * ("ıfake-model" at Android's 125% text): CSS clips a line's first
 * character rather than replace it with "…". So the line wraps instead,
 * one line tall and clipped below: the model part comes first in flex
 * order, so when both no longer fit the provider part drops whole onto the
 * hidden second line. `row-reverse` with `justify-end` still draws
 * `provider:` before the model, and the DOM (copy, screen readers) keeps
 * provider:model. The visible line is the first flex line, so the box's
 * baseline stays the model's. Clip, not hidden: find-in-page cannot
 * scroll the hidden line into view.
 */
export const MODEL_LINE_CLASS = 'min-w-0 max-w-full h-[1lh] flex-row-reverse flex-wrap justify-end overflow-y-clip font-mono'
/** The `provider:` part: whole or not at all. */
export const PROVIDER_PART_CLASS = 'shrink-0 whitespace-nowrap'
/** The model part never shrinks (any share of the overflow, even a fraction
 * of a pixel, would cut it with an ellipsis); capped at the line's width it
 * truncates once the provider part is gone. */
export const MODEL_PART_CLASS = 'order-first max-w-full shrink-0 truncate'

export function ModelName({ id, className, providerClassName, ...rest }: {
  id: string
  className?: string
  /** Tone for the `provider:` part (the run chip mutes it). */
  providerClassName?: string
} & Omit<HTMLAttributes<HTMLSpanElement>, 'id' | 'title' | 'children'>) {
  const { provider, model } = splitModelId(id)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span {...rest} data-model-name className={cn('inline-flex', MODEL_LINE_CLASS, className)}>
            {provider && <span className={cn(PROVIDER_PART_CLASS, providerClassName)}>{provider}:</span>}
            <span className={MODEL_PART_CLASS}>{model}</span>
          </span>
        }
      />
      <TooltipContent>{id}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A model as every surface shows it (DESIGN.md, "One name per thing"):
 * `provider:model` in mono. When space runs out the `provider:` part gives
 * way first and the model part truncates last; the full ID is the app
 * tooltip (never a native title).
 */
import type { HTMLAttributes } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { splitModelId } from '@/lib/run-settings'
import { cn } from '@/lib/utils'

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
          <span {...rest} data-model-name className={cn('inline-flex min-w-0 max-w-full font-mono', className)}>
            {/* The model part never shrinks (any share of the overflow, even a
                fraction of a pixel, would cut it with an ellipsis); it is only
                capped at the full width, so it truncates once the provider
                part has given all of its width away. */}
            {provider && <span className={cn('min-w-0 shrink truncate', providerClassName)}>{provider}:</span>}
            <span className="max-w-full shrink-0 truncate">{model}</span>
          </span>
        }
      />
      <TooltipContent>{id}</TooltipContent>
    </Tooltip>
  )
}

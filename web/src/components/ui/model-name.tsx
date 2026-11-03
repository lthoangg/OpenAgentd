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

const TAIL_MIN = 6
const TAIL_MAX = 14
/** Shorter names fit wherever a model is shown; they are left as one piece. */
const SPLIT_FROM = 13

/**
 * Where a model ID splits so its end stays when it truncates: the shortest
 * end of 6–14 characters that starts a name part (after `-`, `/` or `:`),
 * e.g. `claude-` + `sonnet-4-6`. Families share the start; the variant and
 * version that tell models apart are at the end. ``tail`` is empty for a
 * name under 13 characters or with no such end (it truncates at its end).
 */
export function splitModelTail(model: string): { head: string; tail: string } {
  if (model.length < SPLIT_FROM) return { head: model, tail: '' }
  for (let i = model.length - 1; i > 0; i--) {
    if (!'-/:'.includes(model[i])) continue
    const tail = model.slice(i + 1)
    if (tail.length < TAIL_MIN) continue
    if (tail.length > TAIL_MAX) break
    return { head: model.slice(0, i + 1), tail }
  }
  return { head: model, tail: '' }
}

/**
 * The model part of a `provider:model` line (``MODEL_LINE_CLASS``). A long
 * name gives up its middle: the start truncates, and the end stays whole.
 * Below two characters (where WebKit would clip a letter rather than draw
 * "…") the start drops whole onto the hidden second line, the provider
 * part's trick: it is based at 2ch ("a…"), so it wraps only then, and grows back
 * to its full width when there is room.
 */
export function ModelPart({ model, className }: { model: string; className?: string }) {
  const { head, tail } = splitModelTail(model)
  if (!tail) return <span className={cn(MODEL_PART_CLASS, className)}>{model}</span>
  return (
    <span className={cn('order-first flex h-[1lh] max-w-full shrink-0 flex-row-reverse flex-wrap justify-end overflow-y-clip', className)}>
      <span className="min-w-[2ch] max-w-max grow basis-[2ch] truncate">{head}</span>
      <span className="order-first shrink-0 whitespace-nowrap">{tail}</span>
    </span>
  )
}

export function ModelName({ id, className, providerClassName, tooltip = true, ...rest }: {
  id: string
  className?: string
  /** Tone for the `provider:` part (the run chip mutes it). */
  providerClassName?: string
  /**
   * Show the full ID on hover. Turn it off when an enclosing element has
   * its own tooltip, so two never draw over each other.
   */
  tooltip?: boolean
} & Omit<HTMLAttributes<HTMLSpanElement>, 'id' | 'title' | 'children'>) {
  const { provider, model } = splitModelId(id)
  const label = (
    <span {...rest} data-model-name className={cn('inline-flex', MODEL_LINE_CLASS, className)}>
      {provider && <span className={cn(PROVIDER_PART_CLASS, providerClassName)}>{provider}:</span>}
      <ModelPart model={model} />
    </span>
  )
  if (!tooltip) return label
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipContent>{id}</TooltipContent>
    </Tooltip>
  )
}

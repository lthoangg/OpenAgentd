/**
 * TanStack Markdown extension and UI container for `<proposed_plan>` blocks.
 *
 * Catches `<proposed_plan>` and `</proposed_plan>` XML tags output by the agent
 * during Plan mode, suppressing the raw XML tags from view and rendering the
 * plan inside a styled warm-paper plan card.
 */

import { createContext, useContext, memo, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BlockNode, BlockParseContext, MarkdownExtension } from '@tanstack/markdown'

export interface PlanActionContextValue {
  onStartImplementing?: () => void
}

export const PlanActionContext = createContext<PlanActionContextValue>({})

/**
 * Normalize `<proposed_plan>` and `</proposed_plan>` boundaries so they always
 * sit on their own lines, enabling the block parser to recognize them reliably
 * even when preceded or followed by inline text or tight formatting.
 */
export function normalizeProposedPlanTags(content: string): string {
  if (!content.includes('proposed_plan')) return content
  return content
    .replace(/([^\n])\s*<proposed_plan\b([^>]*)>/gi, '$1\n\n<proposed_plan$2>\n')
    .replace(/<\/proposed_plan>\s*([^\n])/gi, '\n</proposed_plan>\n\n$1')
}

/**
 * Parse `<proposed_plan>...</proposed_plan>` blocks into a `'proposed-plan'`
 * component node with recursively parsed inner markdown children.
 */
export function parseProposedPlanBlock(context: BlockParseContext): BlockNode | undefined {
  const line = context.lines[context.index] ?? ''
  const trimmed = line.trim()
  const openMatch = trimmed.match(/^<proposed_plan\b[^>]*>(.*)$/i)
  if (!openMatch) return undefined

  const firstRest = openMatch[1]?.trim() ?? ''

  // Single-line block: <proposed_plan>...content...</proposed_plan>
  const closeMatch = firstRest.match(/^([\s\S]*?)<\/proposed_plan>/i)
  if (closeMatch) {
    context.consume(1)
    const innerText = closeMatch[1].trim()
    const children = innerText ? context.parseBlocks(innerText) : []
    return {
      type: 'component',
      name: 'proposed-plan',
      tagName: 'proposed-plan',
      attributes: {},
      properties: {},
      children,
    }
  }

  // Multi-line block: scan until </proposed_plan> or EOF (streaming)
  const bodyLines: string[] = []
  if (firstRest) bodyLines.push(firstRest)

  let cursor = context.index + 1
  let closed = false

  while (cursor < context.lines.length) {
    const currentLine = context.lines[cursor] ?? ''
    const closeIdx = currentLine.toLowerCase().indexOf('</proposed_plan>')
    if (closeIdx !== -1) {
      closed = true
      const beforeClose = currentLine.slice(0, closeIdx).trim()
      if (beforeClose) bodyLines.push(beforeClose)
      cursor++
      break
    }
    bodyLines.push(currentLine)
    cursor++
  }

  if (closed) {
    context.consume(cursor - context.index)
  } else {
    // Streaming / unclosed: consume up to end of lines
    context.consume(context.lines.length - context.index)
  }

  const innerText = bodyLines.join('\n').trim()
  const children = innerText ? context.parseBlocks(innerText) : []

  return {
    type: 'component',
    name: 'proposed-plan',
    tagName: 'proposed-plan',
    attributes: {},
    properties: {},
    children,
  }
}

export function planMarkdownExtension(): MarkdownExtension {
  return {
    name: 'proposed-plan',
    parseBlock: parseProposedPlanBlock,
  }
}

export interface ProposedPlanCardProps {
  children?: ReactNode
}

export const ProposedPlanCard = memo(function ProposedPlanCard({ children }: ProposedPlanCardProps) {
  const { onStartImplementing } = useContext(PlanActionContext)

  return (
    <div
      data-testid="proposed-plan-divider"
      role="region"
      aria-label="Proposed plan"
      className="my-4 space-y-3"
    >
      {/* Top divider matching CompactionDivider */}
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
        <span className="font-mono text-xs text-(--color-text-subtle)">
          Proposed plan
        </span>
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
      </div>

      {/* Body: plain assistant-style prose */}
      <div className="space-y-2 text-sm text-(--color-text)">
        {children}
      </div>

      {/* Bottom divider with embedded action (Option A) */}
      <div className="flex items-center gap-3 pt-1">
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
        {onStartImplementing && (
          <Button
            type="button"
            variant="primary"
            size="xs"
            onClick={onStartImplementing}
            className="gap-1 rounded-full font-medium shadow-xs"
            aria-label="Start implementing"
          >
            <Play size={10} className="fill-current" aria-hidden="true" />
            Start implementing
          </Button>
        )}
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
      </div>
    </div>
  )
})

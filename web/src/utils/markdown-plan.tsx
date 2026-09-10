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
 * Find all intervals [start, end] in markdown text that are inside code,
 * either fenced code blocks (``` or ~~~) or inline code spans (`...`).
 */
export function getMarkdownCodeIntervals(content: string): Array<[number, number]> {
  const intervals: Array<[number, number]> = []
  const len = content.length
  let i = 0

  while (i < len) {
    // 1. Fenced code block: must start at start of line with 0-3 leading spaces
    const isLineStart = i === 0 || content[i - 1] === '\n'
    if (isLineStart) {
      let indent = 0
      let p = i
      while (p < len && content[p] === ' ' && indent < 3) {
        p++
        indent++
      }
      const fenceChar = content[p]
      if (fenceChar === '`' || fenceChar === '~') {
        let fenceLen = 0
        let q = p
        while (q < len && content[q] === fenceChar) {
          q++
          fenceLen++
        }
        if (fenceLen >= 3) {
          const lineEnd = content.indexOf('\n', q)
          if (lineEnd === -1) {
            intervals.push([i, len])
            break
          }
          let closeFound = false
          let cur = lineEnd + 1
          while (cur < len) {
            const nextLineEnd = content.indexOf('\n', cur)
            const line = nextLineEnd === -1 ? content.slice(cur) : content.slice(cur, nextLineEnd)
            const closeMatch = line.match(/^[ ]{0,3}(`+|~+)\s*$/)
            if (closeMatch && closeMatch[1]?.[0] === fenceChar && closeMatch[1].length >= fenceLen) {
              const blockEnd = nextLineEnd === -1 ? len : nextLineEnd + 1
              intervals.push([i, blockEnd])
              i = blockEnd
              closeFound = true
              break
            }
            if (nextLineEnd === -1) break
            cur = nextLineEnd + 1
          }
          if (closeFound) continue
          // Unclosed fence (e.g. streaming)
          intervals.push([i, len])
          break
        }
      }
    }

    // 2. Inline code span: backtick run
    if (content[i] === '`') {
      let backtickLen = 0
      let p = i
      while (p < len && content[p] === '`') {
        p++
        backtickLen++
      }
      let closeIdx = -1
      let q = p
      while (q < len) {
        if (content[q] === '`') {
          let count = 0
          while (q < len && content[q] === '`') {
            q++
            count++
          }
          if (count === backtickLen) {
            closeIdx = q
            break
          }
        } else {
          q++
        }
      }

      if (closeIdx !== -1) {
        intervals.push([i, closeIdx])
        i = closeIdx
        continue
      } else {
        // Unclosed inline backticks (e.g. streaming) up to next blank line or EOF
        const nextBlankLine = content.indexOf('\n\n', p)
        const spanEnd = nextBlankLine === -1 ? len : nextBlankLine
        intervals.push([i, spanEnd])
        i = spanEnd
        continue
      }
    }

    i++
  }

  return intervals
}

export function isRangeInsideCode(intervals: Array<[number, number]>, start: number, end: number): boolean {
  return intervals.some(([cStart, cEnd]) => cStart <= start && end <= cEnd)
}

/**
 * Normalize `<proposed_plan>` and `</proposed_plan>` boundaries so they always
 * sit on their own lines, enabling the block parser to recognize them reliably
 * even when preceded or followed by inline text or tight formatting.
 *
 * If `<proposed_plan>` or `</proposed_plan>` is wrapped by backticks (inline code
 * or code fence), it is left untouched so it renders as normal markdown.
 */
export function normalizeProposedPlanTags(content: string): string {
  if (!content.includes('proposed_plan')) return content
  const intervals = getMarkdownCodeIntervals(content)

  let result = content.replace(/([^\n])\s*(<proposed_plan\b[^>]*>)/gi, (match, prefix, tag, offset) => {
    const tagStart = offset + match.length - tag.length
    const tagEnd = offset + match.length
    if (isRangeInsideCode(intervals, tagStart, tagEnd)) {
      return match
    }
    return prefix + '\n\n' + tag + '\n'
  })

  const closingIntervals = result === content ? intervals : getMarkdownCodeIntervals(result)

  result = result.replace(/(<\/proposed_plan>)\s*([^\n])/gi, (match, tag, suffix, offset) => {
    const tagStart = offset
    const tagEnd = offset + tag.length
    if (isRangeInsideCode(closingIntervals, tagStart, tagEnd)) {
      return match
    }
    return '\n' + tag + '\n\n' + suffix
  })

  return result
}

/**
 * Parse `<proposed_plan>...</proposed_plan>` blocks into a `'proposed-plan'`
 * component node with recursively parsed inner markdown children.
 */
export function parseProposedPlanBlock(context: BlockParseContext): BlockNode | undefined {
  const line = context.lines[context.index] ?? ''
  const trimmed = line.trim()
  if (trimmed.startsWith('`') || trimmed.endsWith('`')) return undefined

  const openMatch = trimmed.match(/^<proposed_plan\b[^>]*>(.*)$/i)
  if (!openMatch) return undefined

  const firstRest = openMatch[1]?.trim() ?? ''

  // Single-line block: <proposed_plan>...content...</proposed_plan>
  // Ensure the closing tag is not wrapped in backticks
  const closeRegex = /<\/proposed_plan>/gi
  let match: RegExpExecArray | null
  while ((match = closeRegex.exec(firstRest)) !== null) {
    const closeIdx = match.index
    const lineIntervals = getMarkdownCodeIntervals(firstRest)
    if (!isRangeInsideCode(lineIntervals, closeIdx, closeIdx + match[0].length)) {
      context.consume(1)
      const innerText = firstRest.slice(0, closeIdx).trim()
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
  }

  // Multi-line block: scan until </proposed_plan> (not in backticks) or EOF (streaming)
  const bodyLines: string[] = []
  if (firstRest) bodyLines.push(firstRest)

  let cursor = context.index + 1
  let closed = false

  while (cursor < context.lines.length) {
    const currentLine = context.lines[cursor] ?? ''
    closeRegex.lastIndex = 0
    let foundClose = false
    while ((match = closeRegex.exec(currentLine)) !== null) {
      const closeIdx = match.index
      const lineIntervals = getMarkdownCodeIntervals(currentLine)
      if (!isRangeInsideCode(lineIntervals, closeIdx, closeIdx + match[0].length)) {
        closed = true
        foundClose = true
        const beforeClose = currentLine.slice(0, closeIdx).trim()
        if (beforeClose) bodyLines.push(beforeClose)
        cursor++
        break
      }
    }
    if (foundClose) break
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
            aria-label="Approve"
          >
            <Play size={10} className="fill-current" aria-hidden="true" />
            Approve
          </Button>
        )}
        <span className="h-px flex-1 bg-(--color-border)" aria-hidden />
      </div>
    </div>
  )
})

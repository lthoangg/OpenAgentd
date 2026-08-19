/**
 * KaTeX-powered math rendering extension for Markdown and inline strings.
 *
 * Supports:
 * - Inline math: `$math$` and `\(math\)`
 * - Display math: `$$math$$` and `\[math\]` (single or multi-line)
 * - Fenced math blocks: ```math and ```katex
 *
 * Distinguishes math from currency ($50 and $100) and escaped dollars (\$50).
 */

import { memo, useMemo } from 'react'
import katex from 'katex'
import type { BlockNode, BlockParseContext, InlineNode, MarkdownExtension } from '@tanstack/markdown'

export const MATH_INLINE_SENTINEL = '\uE000math:inline:'
export const MATH_BLOCK_SENTINEL = '\uE000math:block:'

const MATH_REGEX =
  /(?:\\\$)|(?:\$\$([\s\S]+?)\$\$)|(?:\\\[([\s\S]+?)\\\])|(?:\\\(([\s\S]+?)\\\))|(?:\$(?!\s)([^$\n]+?)(?<![\s\\])\$)/g

const htmlCache = new Map<string, string>()
const MAX_CACHE_SIZE = 500

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderKatexHtml(math: string, displayMode: boolean): string {
  const cacheKey = `${displayMode ? 'd' : 'i'}:${math}`
  const cached = htmlCache.get(cacheKey)
  if (cached !== undefined) return cached

  let html: string
  try {
    html = katex.renderToString(math, {
      displayMode,
      throwOnError: false,
    })
  } catch {
    html = `<span class="katex-error">${escapeHtml(math)}</span>`
  }

  if (htmlCache.size >= MAX_CACHE_SIZE) {
    const firstKey = htmlCache.keys().next().value
    if (firstKey !== undefined) {
      htmlCache.delete(firstKey)
    }
  }
  htmlCache.set(cacheKey, html)
  return html
}

export const MathSpan = memo(function MathSpan({ math }: { math: string }) {
  const html = useMemo(() => renderKatexHtml(math, false), [math])
  return (
    <span
      className="oa-math-inline"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

export const MathBlock = memo(function MathBlock({ math }: { math: string }) {
  const html = useMemo(() => renderKatexHtml(math, true), [math])
  return (
    <div
      className="oa-math-block my-2 max-w-full overflow-x-auto text-center"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

// eslint-disable-next-line react-refresh/only-export-components
export function parseMathBlock(context: BlockParseContext): BlockNode | undefined {
  const first = context.lines[context.index] ?? ''
  const trimmed = first.trim()
  if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
    const isBracket = trimmed.startsWith('\\[')
    const openToken = isBracket ? '\\[' : '$$'
    const closeToken = isBracket ? '\\]' : '$$'

    // Single-line block math
    if (
      trimmed.length > 2 &&
      trimmed.endsWith(closeToken) &&
      trimmed.slice(openToken.length).includes(closeToken)
    ) {
      context.consume(1)
      const math = trimmed.slice(openToken.length, -closeToken.length).trim()
      return {
        type: 'component',
        name: 'math-block',
        tagName: 'math-block',
        attributes: { math },
        properties: { 'data-math': math },
        children: [],
      }
    }

    // Multi-line block math
    const body: string[] = []
    const firstRest = trimmed.slice(openToken.length).trim()
    if (firstRest) body.push(firstRest)
    let cursor = context.index + 1
    let closed = false
    while (cursor < context.lines.length) {
      const line = context.lines[cursor] ?? ''
      const trimmedLine = line.trim()
      if (trimmedLine.endsWith(closeToken)) {
        closed = true
        const content = trimmedLine.slice(0, -closeToken.length).trim()
        if (content) body.push(content)
        cursor++
        break
      }
      body.push(line)
      cursor++
    }
    if (closed) {
      context.consume(cursor - context.index)
      const math = body.join('\n').trim()
      return {
        type: 'component',
        name: 'math-block',
        tagName: 'math-block',
        attributes: { math },
        properties: { 'data-math': math },
        children: [],
      }
    }
  }
  return undefined
}

// eslint-disable-next-line react-refresh/only-export-components
export function transformMathInline(nodes: InlineNode[]): InlineNode[] {
  const result: InlineNode[] = []
  for (const node of nodes) {
    if (node.type !== 'text') {
      result.push(node)
      continue
    }
    MATH_REGEX.lastIndex = 0
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MATH_REGEX.exec(node.value)) !== null) {
      if (match[0] === '\\$') {
        if (match.index > lastIndex) {
          result.push({ type: 'text', value: node.value.slice(lastIndex, match.index) })
        }
        result.push({ type: 'text', value: '$' })
        lastIndex = match.index + match[0].length
        continue
      }
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: node.value.slice(lastIndex, match.index) })
      }
      if (match[1] !== undefined) {
        result.push({ type: 'inlineCode', value: `${MATH_BLOCK_SENTINEL}${match[1]}` })
      } else if (match[2] !== undefined) {
        result.push({ type: 'inlineCode', value: `${MATH_BLOCK_SENTINEL}${match[2]}` })
      } else if (match[3] !== undefined) {
        result.push({ type: 'inlineCode', value: `${MATH_INLINE_SENTINEL}${match[3]}` })
      } else if (match[4] !== undefined) {
        result.push({ type: 'inlineCode', value: `${MATH_INLINE_SENTINEL}${match[4]}` })
      }
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < node.value.length) {
      result.push({ type: 'text', value: node.value.slice(lastIndex) })
    }
  }
  return result
}

// eslint-disable-next-line react-refresh/only-export-components
export function mathMarkdownExtension(): MarkdownExtension {
  return {
    name: 'math',
    parseBlock: parseMathBlock,
    transformInline: transformMathInline,
  }
}

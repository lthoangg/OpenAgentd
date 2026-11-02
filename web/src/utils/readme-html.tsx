/**
 * Raw HTML inside a workspace Markdown file — a README's centred logo and
 * badges, `<picture>`, `<details>` — turned into React elements from an
 * allowlist. A cloned repository is untrusted, and this webview holds the
 * server's token, so nothing here uses innerHTML: the fragment is parsed in
 * an inert `<template>` (nothing loads or runs) and only allowed tags and
 * attributes are re-created as React elements. Scripts, styles, frames,
 * forms, SVG and their content are dropped; `class`, `style`, `id` and event
 * handlers never pass (no app styles to borrow, no DOM clobbering); links
 * keep http(s), mailto, in-page and relative targets; images keep http(s),
 * `data:image/` and relative sources, the last through ``resolveSrc``.
 * Unknown tags (`<font>`) unwrap to their content; `<center>` becomes a
 * centred `div`.
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { BlockNode, InlineNode, MarkdownExtension } from '@tanstack/markdown'

const ALLOWED = new Set([
  'p', 'div', 'span', 'a', 'img', 'picture', 'source', 'br', 'hr', 'details', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'sub', 'sup', 'kbd', 'b', 'i', 'u', 'em', 'strong', 'small', 'code', 'pre', 'ul', 'ol', 'li',
  'blockquote', 'del', 's', 'ins', 'mark', 'abbr', 'dl', 'dt', 'dd', 'figure', 'figcaption',
])
/** Dropped with everything inside them. */
const DROPPED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math',
  'noscript', 'template', 'textarea', 'select', 'option', 'button', 'input', 'form', 'title',
  'head', 'link', 'meta', 'base', 'canvas', 'audio', 'video', 'track', 'portal',
])
const VOID = new Set(['img', 'source', 'br', 'hr'])

const ALIGN = /^(?:left|center|right|justify|top|middle|bottom)$/i
const SIZE = /^\d{1,4}(?:%|px)?$/
const COUNT = /^\d{1,3}$/

export interface SafeHtmlOptions {
  /** Resolves a relative image source (against the Markdown file's folder). */
  resolveSrc?: (src: string) => string
  /** Renders `<a>` (the app's Markdown link: opens files in the dock, the rest outside). */
  link?: ComponentType<{ href: string; title?: string; children?: ReactNode }>
}

function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('#') || /^(?:https?:|mailto:)/i.test(value)) return value
  if (value.startsWith('//')) return `https:${value}`
  // Any other scheme (javascript:, data:, file:, vbscript:, …) is refused.
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null
  return value
}

function safeSrc(raw: string, resolve: SafeHtmlOptions['resolveSrc']): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  if (value.startsWith('//')) return `https:${value}`
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/api/')) return null
  return resolve ? resolve(value) : null
}

function safeSrcset(raw: string, resolve: SafeHtmlOptions['resolveSrc']): string | null {
  const parts = raw.split(',').flatMap((entry) => {
    const [url, ...descriptor] = entry.trim().split(/\s+/)
    const src = url ? safeSrc(url, resolve) : null
    return src ? [[src, ...descriptor.filter((d) => /^\d+(?:\.\d+)?[wx]$/.test(d))].join(' ')] : []
  })
  return parts.length ? parts.join(', ') : null
}

function propsFor(el: Element, tag: string, options: SafeHtmlOptions): Record<string, string> | null {
  const props: Record<string, string> = {}
  const attr = (name: string) => el.getAttribute(name)
  const title = attr('title')
  if (title) props.title = title
  const align = attr('align')
  if (align && ALIGN.test(align)) props.align = align.toLowerCase()
  const dir = attr('dir')
  if (dir && /^(?:ltr|rtl|auto)$/i.test(dir)) props.dir = dir.toLowerCase()
  switch (tag) {
    case 'img': {
      const src = safeSrc(attr('src') ?? '', options.resolveSrc)
      if (!src) return null
      props.src = src
      props.alt = attr('alt') ?? ''
      for (const name of ['width', 'height']) {
        const value = attr(name)
        if (value && SIZE.test(value)) props[name] = value
      }
      break
    }
    case 'source': {
      const srcset = safeSrcset(attr('srcset') ?? '', options.resolveSrc)
      if (!srcset) return null
      props.srcSet = srcset
      const media = attr('media')
      if (media && media.length <= 200) props.media = media
      const type = attr('type')
      if (type && /^image\/[\w.+-]+$/i.test(type)) props.type = type
      break
    }
    case 'td':
    case 'th':
      for (const name of ['colspan', 'rowspan']) {
        const value = attr(name)
        if (value && COUNT.test(value)) props[name === 'colspan' ? 'colSpan' : 'rowSpan'] = value
      }
      break
    case 'ol': {
      const start = attr('start')
      if (start && COUNT.test(start)) props.start = start
      break
    }
    case 'details':
      if (el.hasAttribute('open')) props.open = ''
      break
  }
  return props
}

function convert(node: Node, options: SafeHtmlOptions, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent
  if (node.nodeType !== 1) return null
  const el = node as Element
  const tag = el.localName.toLowerCase()
  if (DROPPED.has(tag)) return null
  const children = () => convertChildren(el, options, key)
  if (tag === 'center') return createElement('div', { key, align: 'center' }, children())
  if (!ALLOWED.has(tag)) return children()
  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href') ?? '')
    if (!href) return children()
    const title = el.getAttribute('title') ?? undefined
    if (options.link) return createElement(options.link, { key, href, title }, children())
    return createElement('a', { key, href, title, target: '_blank', rel: 'noopener noreferrer' }, children())
  }
  const props = propsFor(el, tag, options)
  if (!props) return null
  if (tag === 'img') return createElement('img', { key, ...props, loading: 'lazy', className: 'inline max-w-full h-auto' })
  if (VOID.has(tag)) return createElement(tag, { key, ...props })
  return createElement(tag, { key, ...props }, children())
}

function convertChildren(parent: ParentNode, options: SafeHtmlOptions, key: string): ReactNode[] {
  return Array.from(parent.childNodes, (child, index) => convert(child, options, `${key}.${index}`))
}

/** ``html`` (a fragment from a Markdown file) as safe React elements. */
export function renderSafeHtml(html: string, options: SafeHtmlOptions = {}): ReactNode[] {
  if (typeof document === 'undefined') return []
  const template = document.createElement('template')
  template.innerHTML = html
  return convertChildren(template.content, options, 'h')
}

/**
 * The element an inline opening tag (``<kbd>``, ``<a href="…">``) makes,
 * around ``children`` that Markdown already rendered. A dropped tag drops
 * its content too; an unknown one leaves the content.
 */
export function renderSafeWrapper(openTag: string, tag: string, children: ReactNode, options: SafeHtmlOptions = {}): ReactNode {
  if (typeof document === 'undefined') return children
  const template = document.createElement('template')
  template.innerHTML = `${openTag}</${tag}>`
  const el = template.content.firstElementChild
  if (!el) return children
  const name = el.localName.toLowerCase()
  if (DROPPED.has(name)) return null
  if (name === 'center') return createElement('div', { align: 'center' }, children)
  if (!ALLOWED.has(name) || VOID.has(name)) return children
  if (name === 'a') {
    const href = safeHref(el.getAttribute('href') ?? '')
    if (!href) return children
    const title = el.getAttribute('title') ?? undefined
    if (options.link) return createElement(options.link, { href, title }, children)
    return createElement('a', { href, title, target: '_blank', rel: 'noopener noreferrer' }, children)
  }
  const props = propsFor(el, name, options)
  return props ? createElement(name, props, children) : children
}

// ── Markdown extension ──────────────────────────────────────────────────────
//
// With ``allowHtml`` the parser keeps HTML as ``html`` / ``inlineHtml`` nodes,
// which its renderer would inject raw. This extension turns every one into a
// component the app renders through ``renderSafeHtml``, so raw HTML never
// reaches the renderer: blocks become ``oa-html``, a ``<details>`` block and
// the Markdown up to its ``</details>`` become ``oa-details`` (so the content
// folds), and inline tags become ``oa-html-inline`` (void tags) or wrap the
// Markdown between an opening tag and its closing one. Tags left over (an
// unmatched ``</a>``, a comment) are dropped.

const DETAILS_OPEN = /^\s*<details\b([^>]*)>/i
const DETAILS_CLOSE = /^\s*<\/details\s*>/i

function htmlBlock(value: string): BlockNode {
  return { type: 'component', name: 'oa-html', attributes: {}, children: [], tagName: 'oa-html', properties: { 'data-html': value } }
}

function transformBlocks(nodes: BlockNode[]): BlockNode[] {
  const out: BlockNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'html') {
      out.push(transformBlockChildren(node))
      continue
    }
    const open = DETAILS_OPEN.exec(node.value)
    if (open && !/<\/details\s*>/i.test(node.value)) {
      const end = nodes.findIndex((n, j) => j > i && n.type === 'html' && DETAILS_CLOSE.test(n.value))
      if (end > i) {
        const closing = nodes[end] as Extract<BlockNode, { type: 'html' }>
        const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(node.value)?.[1] ?? ''
        out.push({
          type: 'component',
          name: 'oa-details',
          attributes: {},
          tagName: 'oa-details',
          properties: { 'data-summary': summary, 'data-open': /\bopen\b/i.test(open[1]) ? 'true' : 'false' },
          children: transformBlocks(nodes.slice(i + 1, end)),
        })
        const rest = closing.value.replace(DETAILS_CLOSE, '').trim()
        if (rest) out.push(htmlBlock(rest))
        i = end
        continue
      }
    }
    out.push(htmlBlock(node.value))
  }
  return out
}

/** Blocks nested in lists, quotes, callouts and components. */
function transformBlockChildren(node: BlockNode): BlockNode {
  switch (node.type) {
    case 'list':
      return { ...node, items: node.items.map((item) => ({ ...item, children: transformBlocks(item.children) })) }
    case 'blockquote':
    case 'callout':
    case 'component':
      return { ...node, children: transformBlocks(node.children) } as BlockNode
    default:
      return node
  }
}

const OPEN_TAG = /^<([a-z][a-z\d-]*)\b[^>]*>$/i
const VOID_TAG = /^<(?:img|br|hr)\b[^>]*>$/i

function transformInlines(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'inlineHtml') {
      out.push(node)
      continue
    }
    const value = node.value.trim()
    if (VOID_TAG.test(value)) {
      out.push({ type: 'inlineComponent', name: 'oa-html-inline', attributes: {}, children: [], tagName: 'oa-html-inline', properties: { 'data-html': value } })
      continue
    }
    const open = OPEN_TAG.exec(value)
    if (open && !value.endsWith('/>')) {
      const tag = open[1].toLowerCase()
      const close = new RegExp(`^</${tag}\\s*>$`, 'i')
      const end = nodes.findIndex((n, j) => j > i && n.type === 'inlineHtml' && close.test(n.value.trim()))
      if (end > i) {
        out.push({
          type: 'inlineComponent',
          name: 'oa-html-wrap',
          attributes: {},
          tagName: 'oa-html-wrap',
          properties: { 'data-open': value, 'data-tag': tag },
          children: transformInlines(nodes.slice(i + 1, end)),
        })
        i = end
        continue
      }
    }
    // An unmatched tag or a comment: nothing to show.
  }
  return out
}

/** Turns parsed HTML into the app's safe components (see above). Use with ``allowHtml``. */
export function safeHtmlMarkdownExtension(): MarkdownExtension {
  return {
    name: 'oa-safe-html',
    transformDocument: (document) => ({ ...document, children: transformBlocks(document.children) }),
    transformInline: (nodes) => transformInlines(nodes),
  }
}

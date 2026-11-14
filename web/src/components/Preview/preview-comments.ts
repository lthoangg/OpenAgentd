/**
 * Design comments left on preview elements, and the design feedback that
 * hands them to the agent (see ``@/lib/design-feedback``).
 *
 * Source files inside the workspace become ``@path#Lx-Ly`` references, so
 * the backend attaches those lines to the message like any other mention.
 */
import { type PreviewTarget, previewTargetKey } from '@/api/preview'
import type { DesignFeedback, DesignFeedbackItem } from '@/lib/design-feedback'
import type { ElementDescriptor, ElementSource } from './preview-protocol'

export const PREVIEW_COMMENT_MAX_CHARS = 2000
/** Lines attached from an element's source line: the element and its children. */
export const SOURCE_WINDOW_LINES = 30

export interface PreviewComment {
  id: string
  /** Pin number shown on the page. */
  n: number
  element: ElementDescriptor
  text: string
}

/**
 * ``removed`` put back among ``current``, in pin order (Undo after Clear or
 * the x on one comment). A comment keeps its number unless a newer comment
 * took it meanwhile; then it gets the next free one.
 */
export function restoreComments(current: readonly PreviewComment[], removed: readonly PreviewComment[]): PreviewComment[] {
  const taken = new Set(current.map((c) => c.n))
  let next = Math.max(0, ...current.map((c) => c.n), ...removed.map((c) => c.n)) + 1
  const back = removed.map((comment) => {
    if (!taken.has(comment.n)) {
      taken.add(comment.n)
      return comment
    }
    const n = next++
    return { ...comment, id: `c${n}`, n }
  })
  return [...current, ...back].sort((a, b) => a.n - b.n)
}

/** ``<button.cta>`` / ``<div#root>`` */
export function elementLabel(element: Pick<ElementDescriptor, 'tag' | 'id' | 'classes'>): string {
  const suffix = element.id ? `#${element.id}` : element.classes.length ? `.${element.classes.slice(0, 2).join('.')}` : ''
  return `<${element.tag}${suffix}>`
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Workspace-relative path for a framework source file, or ``null`` when it
 * lies outside the workspace. Relative paths are taken as workspace paths.
 */
export function workspaceRelative(file: string, workspace: string): string | null {
  const normalized = file.replace(/\\/g, '/').replace(/^\/@fs\//, '/').split('?')[0]
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)) {
    const rel = normalized.replace(/^\.\//, '')
    return rel && !rel.startsWith('../') ? rel : null
  }
  const root = trimSlashes(workspace)
  if (!root) return null
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : null
}

/**
 * The workspace file behind a source path the dev server reported, or
 * ``null`` to keep ``file`` as it is. React 19 sources arrive as served
 * paths (``/src/Pricing.tsx``), relative to the dev server's root, which may
 * be a workspace subfolder; they are matched by suffix against ``files``
 * (workspace-relative), shortest match first.
 */
export function resolveSourceFile(file: string, workspace: string, files: readonly string[]): string | null {
  if (!files.length) return null
  const normalized = file.replace(/\\/g, '/').replace(/^\/@fs\//, '/').split('?')[0]
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
  const rel = workspaceRelative(normalized, workspace)
  if (rel && (absolute || files.includes(rel))) return null
  const tail = `/${normalized.replace(/^\.?\/+/, '')}`
  let best: string | null = null
  for (const path of files) {
    if (`/${path}`.endsWith(tail) && (best === null || path.length < best.length)) best = path
  }
  return best === null ? null : `${trimSlashes(workspace)}/${best}`
}

/** ``src/App.tsx#L42-L71`` / ``src/App.vue`` for a source inside the workspace, else ``null``. */
function sourceMention(source: ElementSource | null, workspace: string): string | null {
  if (!source?.file) return null
  const rel = workspaceRelative(source.file, workspace)
  if (!rel) return null
  return source.line && source.line > 0 ? `${rel}#L${source.line}-L${source.line + SOURCE_WINDOW_LINES - 1}` : rel
}

/** ``@src/App.tsx#L42-L71``, ``@src/App.vue``, or the raw path outside the workspace. */
export function sourceReference(source: ElementSource | null, workspace: string): string | null {
  if (!source?.file) return null
  const mention = sourceMention(source, workspace)
  if (mention) return `@${mention}`
  const line = source.line && source.line > 0 ? source.line : null
  return line ? `${source.file}:${line}` : source.file
}

function shorten(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// Computed values that say nothing about the design.
const TRIVIAL_STYLE = /^(none|normal|auto|static|0px|rgba\(0, 0, 0, 0\)|0px none.*|medium none.*)$/

/** ``font-size: 14px; color: rgb(…)``: the element's non-default key styles. */
export function compactStyles(styles: Record<string, string>): string {
  return Object.entries(styles)
    .filter(([, v]) => v && !TRIVIAL_STYLE.test(v.trim()))
    .map(([k, v]) => `${k}: ${v.trim()}`)
    .join('; ')
}

export interface BuildDesignFeedbackArgs {
  comments: readonly PreviewComment[]
  workspace: string
  /** Dev server origin (``http://localhost:5173``), or ``null`` for a workspace file preview. */
  origin: string | null
  /** Workspace file shown by a file preview. */
  filePath?: string | null
  /** ``Mobile 390×844`` */
  device: string
}

/** The design feedback for a batch of comments. */
export function buildDesignFeedback({ comments, workspace, origin, filePath = null, device }: BuildDesignFeedbackArgs): DesignFeedback {
  const paths = new Set(comments.map((c) => c.element.path))
  const onePath = paths.size === 1 ? comments[0]?.element.path ?? '/' : null
  const where = origin
    ? `${origin}${onePath ?? ''}`
    : filePath
      ? `@${filePath}`
      : 'the preview'
  return {
    where,
    device,
    items: comments.map((comment, index) => {
      const el = comment.element
      return {
        n: index + 1,
        element: elementLabel(el),
        text: shorten(el.text),
        selector: el.selector,
        source: sourceReference(el.source, workspace) ?? (el.source?.component ? `component ${el.source.component}` : null),
        html: el.html,
        styles: compactStyles(el.styles),
        page: onePath ? null : el.path,
        comment: comment.text.trim(),
      }
    }),
  }
}

// ── Sent feedback back into comments ─────────────────────────────────────

/** ``{ tag, id, classes }`` from ``<button.cta.primary>`` or ``<div#hero>``. */
function parseLabel(label: string): Pick<ElementDescriptor, 'tag' | 'id' | 'classes'> {
  const m = /^<([^#.>]+)(?:#([^>]+)|((?:\.[^.>]+)*))>$/.exec(label.trim())
  if (!m) return { tag: 'element', id: null, classes: [] }
  return { tag: m[1], id: m[2] ?? null, classes: m[3] ? m[3].slice(1).split('.') : [] }
}

/** The source an item was written from (see ``sourceReference``). */
function parseSource(source: string | null): ElementSource | null {
  if (!source) return null
  if (source.startsWith('component ')) return { file: null, line: null, component: source.slice('component '.length) }
  const ref = /^@(.+?)(?:#L(\d+)(?:-L\d+)?)?$/.exec(source)
  if (ref) return { file: ref[1], line: ref[2] ? Number(ref[2]) : null, component: null }
  const raw = /^(.+):(\d+)$/.exec(source)
  return raw ? { file: raw[1], line: Number(raw[2]), component: null } : { file: source, line: null, component: null }
}

function parseStyles(styles: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of styles.split(/;\s(?=[a-z-]+:\s)/)) {
    const at = part.indexOf(': ')
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 2)
  }
  return out
}

/** Page path of the comments when ``where`` names a single page. */
function pathOf(where: string): string {
  if (where.startsWith('@')) return `/${where.slice(1)}`
  try {
    const u = new URL(where)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return '/'
  }
}

/**
 * Comments rebuilt from design feedback (a chip removed from the composer),
 * complete enough to pin, edit, and send again.
 */
export function commentsFromFeedback(feedback: DesignFeedback): { element: ElementDescriptor; text: string }[] {
  const page = pathOf(feedback.where)
  return feedback.items.map((item: DesignFeedbackItem) => ({
    text: item.comment,
    element: {
      ...parseLabel(item.element),
      selector: item.selector,
      role: null,
      ariaLabel: null,
      text: item.text,
      html: item.html,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      styles: parseStyles(item.styles),
      source: parseSource(item.source),
      path: item.page ?? page,
    },
  }))
}

/** The Preview tab design feedback was sent from. */
export function previewTargetForFeedback(feedback: DesignFeedback): PreviewTarget | null {
  if (feedback.where.startsWith('@')) return { kind: 'file', path: feedback.where.slice(1) }
  if (/^https?:\/\//.test(feedback.where)) return { kind: 'url', url: feedback.where }
  return null
}

/** Was ``feedback`` sent from a tab showing ``target``? */
export function feedbackMatchesTarget(feedback: DesignFeedback, target: PreviewTarget): boolean {
  const from = previewTargetForFeedback(feedback)
  return from !== null && previewTargetKey(from) === previewTargetKey(target)
}

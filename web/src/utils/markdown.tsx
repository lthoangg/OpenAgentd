/**
 * Shared markdown rendering utilities.
 *
 * Used by AgentView (single-agent) and AgentPane (split/unified).
 * Keeps syntax highlighting, CodeBlock styling, and fixNestedFences in sync
 * across all views.
 */

import { memo, useMemo, useState } from 'react'
import { Markdown } from '@tanstack/markdown/react'
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming'
import { ImageOff, FileVideo } from 'lucide-react'
import { resolveApiUrl } from '@/api/client'
import { apiUrl } from '@/api/base-url'
import { withTokenParam } from '@/api/auth'
import { ImageLightbox } from '@/components/ImageLightbox'
import { CodeBlock } from '@/components/CodeBlock'
import { tokenizeCode } from '@/utils/code-highlight'
import { MermaidBlock } from '@/utils/MermaidBlock'
import { isVideoSrc } from '@/utils/workspace'

// ── fixNestedFences ───────────────────────────────────────────────────────────

/**
 * Fix nested fenced code blocks for CommonMark.
 *
 * Problem: a ```markdown outer fence gets closed by the first bare ``` inside
 * (e.g. closing ```python inner block) because they're the same length.
 *
 * Fix: walk line-by-line, track nesting depth per fence length, and
 * re-fence any outer block whose body contains backtick runs long enough
 * to close it — using one more backtick than the longest inner run.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function fixNestedFences(content: string): string {
  // Most streamed prose has no fenced code. Avoid allocating and walking a
  // line array on every display update when nested-fence repair cannot apply.
  if (!content.includes('```')) return content

  const lines = content.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const openMatch = lines[i].match(/^(`{3,})(\w*)(.*)$/)
    if (openMatch) {
      const openFence = openMatch[1]
      const lang = openMatch[2]
      const rest = openMatch[3]
      const openLen = openFence.length

      // Me scan forward tracking depth — a bare close fence of same length closes the block
      const bodyLines: string[] = []
      let j = i + 1
      let depth = 1
      while (j < lines.length) {
        const fenceMatch = lines[j].match(/^(`{3,})\s*(\w*).*$/)
        if (fenceMatch) {
          const fLen = fenceMatch[1].length
          if (fLen === openLen) {
            if (fenceMatch[2] === '') {
              depth--
              if (depth === 0) break  // Me found true closer
            } else {
              depth++  // Me nested opener of same length
            }
          }
        }
        bodyLines.push(lines[j])
        j++
      }

      if (depth !== 0 || j >= lines.length) {
        // Me unclosed — emit as-is and move on
        result.push(lines[i])
        i++
        continue
      }

      const body = bodyLines.join('\n')
      // Me find longest backtick run inside body
      const backtickRuns = [...body.matchAll(/`+/g)].map((m) => m[0].length)
      const maxInner = backtickRuns.length > 0 ? Math.max(...backtickRuns) : 0
      if (maxInner >= openLen) {
        // Me re-fence with enough backticks so inner fences can't close the outer block
        const newFence = '`'.repeat(maxInner + 1)
        result.push(newFence + lang + rest)
        result.push(...bodyLines)
        result.push(newFence)
      } else {
        result.push(lines[i])
        result.push(...bodyLines)
        result.push(lines[j])
      }
      i = j + 1
    } else {
      result.push(lines[i])
      i++
    }
  }

  return result.join('\n')
}

const STREAMING_MERMAID_LANGUAGE = 'mermaid-complete'

/**
 * Mark only closed Mermaid fences during a stream so completed diagrams do not
 * wait for the whole response. This follows fixNestedFences' equal-length,
 * bare-closer convention, leaving an unfinished fence on the CodeBlock path.
 */
function markClosedStreamingMermaidFences(content: string): string {
  if (!content.includes('```mermaid')) return content

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const openMatch = lines[i].match(/^(`{3,})mermaid\s*$/i)
    if (!openMatch) continue

    const fenceLength = openMatch[1].length
    let depth = 1
    for (let j = i + 1; j < lines.length; j++) {
      const fenceMatch = lines[j].match(/^(`{3,})\s*(\w*).*$/)
      if (!fenceMatch || fenceMatch[1].length !== fenceLength) continue
      if (fenceMatch[2] === '') {
        depth--
        if (depth === 0) {
          lines[i] = `${openMatch[1]}${STREAMING_MERMAID_LANGUAGE}`
          break
        }
      } else {
        depth++
      }
    }
  }

  return lines.join('\n')
}

// ── HighlightedCode ───────────────────────────────────────────────────────────

/** A fenced code block, syntax-highlighted from a token stream.
 *
 * **Why highlighting lives here rather than in the markdown pipeline**: the
 * renderer re-parses the whole accumulated response on every streamed delta,
 * so a parser-level highlighter (the old ``rehype-highlight`` plugin) re-ran
 * highlight.js over *every* code block in the message on *every* token.
 * Hoisting it into a memoized component keyed on the code text means a fence
 * is highlighted once and then skipped until its content actually changes —
 * only the block still being written costs anything.
 *
 * Tokens become React elements rather than an HTML string, so model-authored
 * code is escaped by React and never reaches ``dangerouslySetInnerHTML``. An
 * unrecognised language tokenises to a single unclassified span, which renders
 * as plain text.
 */
const HighlightedCode = memo(function HighlightedCode({
  code,
  language,
}: {
  code: string
  language?: string
}) {
  const content = useMemo((): React.ReactNode => {
    const tokens = tokenizeCode(code, language)
    return tokens.map((token, index) =>
      token.className ? (
        <span key={index} className={`th-token th-${token.className}`}>
          {token.value}
        </span>
      ) : (
        token.value
      ),
    )
  }, [code, language])

  return (
    <CodeBlock language={language} rawText={code}>
      {content}
    </CodeBlock>
  )
})

// ── resolveImageSrc ───────────────────────────────────────────────────────────

/**
 * Extract the display filename from a markdown media ``src`` or raw markdown URL.
 *
 * Examples:
 * - "chart.png" -> "chart.png"
 * - "output/plots/density.png" -> "density.png"
 * - "http://example.com/demo.mp4?v=1#t=0" -> "demo.mp4"
 * - "my%20file.png" -> "my file.png"
 * - "data:image/png;base64,..." -> null
 * - "blob:..." -> null
 */
// eslint-disable-next-line react-refresh/only-export-components
export function extractFileName(rawSrc?: string, resolvedSrc?: string): string | null {
  const target = rawSrc || resolvedSrc
  if (!target) return null
  if (target.startsWith('data:') || target.startsWith('blob:')) return null
  const pathOnly = target.split('?')[0].split('#')[0]
  if (!pathOnly) return null
  const cleaned = pathOnly.replace(/\/+$/, '')
  if (!cleaned) return null
  const lastSegment = cleaned.substring(cleaned.lastIndexOf('/') + 1)
  if (!lastSegment) return null
  try {
    return decodeURIComponent(lastSegment)
  } catch {
    return lastSegment
  }
}

/**
 * Rewrite a markdown media ``src`` for rendering.
 *
 * Used for both images and videos — videos reach this helper through the
 * same ``![alt](file.ext)`` markdown path as images, because browsers don't
 * natively embed ``<video>`` from markdown. The downstream renderer
 * (``MarkdownImage``) inspects the extension via ``isVideoSrc`` and swaps in
 * a ``<video controls>`` element when appropriate.
 *
 * Rules:
 * - Absolute URLs (http/https), data:, blob:, and protocol-relative (`//...`)
 *   pass through unchanged.
 * - Bare relative paths are resolved against the agent workspace via the
 *   backend media proxy: ``/api/team/{sessionId}/media/{src}``.
 * - When no ``sessionId`` is available (e.g. standalone previews), the raw
 *   src is returned — the browser will show a broken image, which is the
 *   correct signal that the renderer lacks a session context.
 *
 * Exported for direct unit testing.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveImageSrc(src: string | undefined, sessionId?: string): string | undefined {
  if (!src) return src
  // Absolute / external / inline — passthrough.
  if (/^(https?:)?\/\//i.test(src)) return src
  if (src.startsWith('data:') || src.startsWith('blob:')) return src
  // Already points at our API — passthrough (avoid double-prefixing).
  if (src.startsWith('/api/')) return resolveApiUrl(src)
  // Bare path but no session to anchor against — passthrough (broken image).
  if (!sessionId) return src
  // Strip any leading ``./`` and any leading ``/`` to keep the proxy URL clean.
  const cleaned = src.replace(/^\.\//, '').replace(/^\/+/, '')
  return withTokenParam(apiUrl(`/team/${encodeURIComponent(sessionId)}/media/${cleaned}`))
}

// ── MarkdownVideo ─────────────────────────────────────────────────────────────

/** Inline video inside markdown prose.
 *
 * Rendered when ``resolveImageSrc`` points at a workspace file with a video
 * extension (``.mp4`` / ``.webm`` / ``.mov`` / ``.m4v``). Uses the native
 * HTML5 video player with controls; no click-to-enlarge (controls already
 * expose fullscreen). On permanent load failure, shows a compact
 * placeholder with the alt text so paragraph flow isn't broken — same UX
 * as the broken-image fallback.
 *
 * **Why ``React.memo``**: during SSE streaming, the parent ``MarkdownBlock``
 * re-renders on every content chunk. Without memo-ing by ``src``, React
 * reconciliation recreates the ``<video>`` element enough to re-trigger
 * buffering/decoding each render, which the browser (plus our own
 * ``onError`` fallback swap) amplifies into a visible flicker loop. Image
 * elements don't suffer from this because the browser caches the decoded
 * bitmap; video elements restart their media element state machine when
 * attributes change.
 *
 * **Why the ``onError`` guard**: media elements fire transient ``error``
 * events during normal loading (e.g. source resolution races, network
 * hiccups) that resolve on their own. Unconditionally flipping to the
 * fallback creates a render cycle where the next render remounts the
 * video, fires another transient error, swaps back, and so on. We only
 * treat an error as permanent once the element's ``networkState`` has
 * settled on ``NETWORK_NO_SOURCE`` — the actual terminal "this URL
 * won't load" signal.
 */
const MarkdownVideo = memo(function MarkdownVideo({
  src,
  alt,
  title,
  rawSrc,
}: {
  src: string
  alt: string
  title?: string
  rawSrc?: string
}) {
  const [errored, setErrored] = useState(false)
  const fileName = extractFileName(rawSrc, src)

  if (errored) {
    return (
      <span className="my-2 inline-block max-w-full">
        <span
          className="inline-flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)"
          title={alt || 'Video unavailable'}
        >
          <FileVideo size={14} />
          {alt || 'Video unavailable'}
        </span>
        {fileName && (
          <span className="mt-1 block text-center text-xs text-(--color-text-muted) break-all">
            {fileName}
          </span>
        )}
      </span>
    )
  }

  return (
    <span className="my-2 inline-block max-w-full">
      <video
        src={src}
        title={title ?? alt}
        controls
        preload="metadata"
        playsInline
        onError={(e) => {
          // Only treat as terminal when the element reports NO_SOURCE.
          // Transient errors during buffering/codec negotiation are otherwise
          // ignored to avoid a flicker loop with the fallback placeholder.
          const el = e.currentTarget
          if (el.networkState === el.NETWORK_NO_SOURCE) {
            setErrored(true)
          }
        }}
        className="block max-h-[80vh] max-w-full rounded-lg border border-(--color-border) bg-black"
      >
        {/* Fallback text for environments without <video> support (rare). */}
        {alt || 'Video content'}
      </video>
      {fileName && (
        <span className="mt-1 block text-center text-xs text-(--color-text-muted) break-all">
          {fileName}
        </span>
      )}
    </span>
  )
})

// ── MarkdownImage ─────────────────────────────────────────────────────────────

/** Inline image (or video) inside markdown prose.
 *
 * Clicks open the shared ``ImageLightbox`` for a full-screen preview —
 * identical UX to user-uploaded ``ImageAttachment`` thumbnails.  On load
 * failure, renders a compact broken-image placeholder instead of leaving
 * a blank alt-text gap that breaks paragraph flow.
 *
 * When ``src`` ends in a known video extension, delegates to ``MarkdownVideo``
 * so agents using ``generate_video`` (``![prompt](clip.mp4)``) get an inline
 * HTML5 player without a new markdown syntax.
 */
function MarkdownImage({
  src,
  alt,
  title,
  rawSrc,
}: {
  src: string | undefined
  alt: string
  title?: string
  rawSrc?: string
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [errored, setErrored] = useState(false)
  const fileName = extractFileName(rawSrc, src)

  if (!src || errored) {
    return (
      <span className="my-2 inline-block max-w-full">
        <span
          className="inline-flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--bg-card) px-3 py-2 text-xs text-(--color-text-muted)"
          title={alt || 'Image unavailable'}
        >
          <ImageOff size={14} />
          {alt || 'Image unavailable'}
        </span>
        {fileName && (
          <span className="mt-1 block text-center text-xs text-(--color-text-muted) break-all">
            {fileName}
          </span>
        )}
      </span>
    )
  }

  // Videos travel through the same ``![alt](path)`` markdown as images but
  // render as <video> — extension-based routing keeps the markdown authoring
  // contract identical for image and video tools.
  if (isVideoSrc(src)) {
    return <MarkdownVideo src={src} alt={alt} title={title} rawSrc={rawSrc} />
  }

  return (
    <span className="my-2 inline-block max-w-full">
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        aria-label={alt ? `Open image preview: ${alt}` : 'Open image preview'}
      >
        <img
          src={src}
          alt={alt}
          title={title}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          className="max-h-[80vh] max-w-full cursor-zoom-in object-contain rounded-lg border border-(--color-border) transition-opacity hover:opacity-90"
        />
      </button>
      {fileName && (
        <span className="mt-1 block text-center text-xs text-(--color-text-muted) break-all">
          {fileName}
        </span>
      )}
      <ImageLightbox
        src={src}
        alt={alt}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </span>
  )
}

function renderCellWithBr(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    const regex = /<br\s*\/?>/i
    if (regex.test(children)) {
      const parts = children.split(regex)
      return parts.reduce<React.ReactNode[]>((acc, part, i) => {
        if (i > 0) acc.push(<br key={`br-${i}`} />)
        if (part) acc.push(part)
        return acc
      }, [])
    }
    return children
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <span key={i}>{renderCellWithBr(child)}</span>
    ))
  }
  if (children && typeof children === 'object' && 'props' in children) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>
    if (el.props && 'children' in el.props) {
      return {
        ...el,
        props: {
          ...el.props,
          children: renderCellWithBr(el.props.children),
        },
      }
    }
  }
  return children
}

// ── MarkdownBlock ─────────────────────────────────────────────────────────────

/** Shared prose markdown renderer — handles nested fences with math and syntax highlighting.
 *
 * When ``sessionId`` is provided, bare image paths in ``![alt](path)`` are
 * rewritten to the backend media proxy so agents can reference files they
 * wrote into the workspace (e.g. ``![chart](chart.png)``).  All rendered
 * images open a full-screen lightbox on click.
 */
export const MarkdownBlock = memo(function MarkdownBlock({
  content,
  sessionId,
  isStreaming = false,
}: {
  content: string
  sessionId?: string
  isStreaming?: boolean
}) {
  // Me: the ``components`` map MUST be referentially stable across renders.
  // If we rebuild it inline every render, the renderer treats each call
  // as a new custom-component type and unmounts+remounts every ``<img>`` /
  // ``<MarkdownVideo>`` subtree — which restarts ``<video>`` buffering and
  // causes a visible flicker whenever the parent re-renders (e.g. on every
  // wheel/touchmove tick from ``AgentView``'s scroll-position tracker).
  // Memoizing on ``sessionId`` — the only captured value — keeps the same
  // function identities as long as the session doesn't change.
  const components = useMemo(
    () => ({
      // The renderer hands ``pre`` the fence language on ``data-lang`` and the
      // raw source as the ``<code>`` element's single string child — no
      // highlighter is configured, so nothing has wrapped it in spans yet.
      pre: (props: React.HTMLAttributes<HTMLPreElement> & { 'data-lang'?: string }) => {
        const codeEl = props.children as React.ReactElement<{ children?: unknown }>
        const codeText = typeof codeEl?.props?.children === 'string' ? codeEl.props.children : ''
        // ``data-lang`` falls back to "plaintext" for a bare fence, where the
        // old pipeline left the language undefined — and CodeBlock keys its
        // header row off exactly that.
        const rawLanguage = props['data-lang']
        const language = !rawLanguage || rawLanguage === 'plaintext' ? undefined : rawLanguage
        const normalizedLanguage = language?.toLowerCase()
        const isMermaid = normalizedLanguage === 'mermaid'
          || normalizedLanguage === STREAMING_MERMAID_LANGUAGE
        if (isMermaid && (!isStreaming || normalizedLanguage === STREAMING_MERMAID_LANGUAGE)) {
          return <MermaidBlock source={codeText} highlightedCode={codeText} />
        }
        return <HighlightedCode code={codeText} language={language} />
      },
      table: (props: React.HTMLAttributes<HTMLTableElement>) => (
        <div className="oa-table-wrap">
          <table {...props} />
        </div>
      ),
      td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
        <td {...props}>{renderCellWithBr(children)}</td>
      ),
      th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
        <th {...props}>{renderCellWithBr(children)}</th>
      ),
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a {...props} target="_blank" rel="noopener noreferrer" />
      ),
      img: ({ src, alt, title }: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <MarkdownImage
          rawSrc={typeof src === 'string' ? src : undefined}
          src={resolveImageSrc(typeof src === 'string' ? src : undefined, sessionId)}
          alt={alt ?? ''}
          title={typeof title === 'string' ? title : undefined}
        />
      ),
    }),
    [isStreaming, sessionId],
  )

  // Me: fixNestedFences is pure; memoize so we don't re-walk the whole
  // string on scroll-triggered parent re-renders either.
  const fixedContent = useMemo(() => fixNestedFences(content), [content])
  const renderedContent = useMemo(
    () => isStreaming ? markClosedStreamingMermaidFences(fixedContent) : fixedContent,
    [fixedContent, isStreaming],
  )

  return (
    <div className="oa-prose text-sm">
      <Markdown
        extensions={_EXTENSIONS}
        frontmatter={false}
        headingIds={false}
        components={components}
      >
        {renderedContent}
      </Markdown>
    </div>
  )
})

// Me: module-level constant so every ``MarkdownBlock`` instance shares one
// extension array identity across renders.
//
// ``streamingMarkdownExtension`` suppresses the empty trailing heading /
// blockquote / list item that a half-typed line produces, so a response does
// not flash a stray bullet or ``<h2>`` on its way in. It stays enabled after
// the stream closes: a genuinely empty trailing heading is not something an
// agent response ever means.
//
// ``frontmatter`` is off so a completed ``---`` later in a response cannot
// retroactively reinterpret its opening lines as metadata, and ``headingIds``
// is off because a streamed heading would otherwise change its own element id
// on every delta.
const _EXTENSIONS = [streamingMarkdownExtension()]

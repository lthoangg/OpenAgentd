/**
 * A ``mermaid`` fence drawn as a diagram, with a Code view and copy.
 *
 * Pele (``pele/lazy``) draws it: a small, dependency-free Mermaid renderer
 * that loads on the first diagram, then each diagram type on first use, so
 * the startup bundle does not grow. Colors and fonts come from CSS variables
 * (``.oa-diagram`` in ``index.css``), so a theme switch needs no redraw, and
 * ``mount`` adapts the layout to the column width and adds zoom when a
 * diagram has to shrink. Links and images are off, and every SVG passes
 * through ``sanitizeDiagramSvg`` before it is inserted.
 *
 * Source that Pele cannot draw falls back to the code with a one-line
 * reason; the message around it is never affected.
 *
 * A diagram squeezed into a narrow column can open full screen, where it is
 * drawn again for the window's width (Pele re-lays it out, not just scales it)
 * with zoom always on.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Copy, Maximize2, X } from 'lucide-react'
import type { MountOptions, Mounted } from 'pele/lazy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText, useChatMenu } from '@/components/ChatContextMenu'
import { useKeyLayer } from '@/lib/keyboard/hooks'
import { sanitizeDiagramSvg } from './diagram-svg'

type Pele = typeof import('pele/lazy')
let pele: Promise<Pele> | null = null
const loadPele = () => (pele ??= import('pele/lazy'))

const OPTIONS: MountOptions = {
  links: false,
  images: false,
  zoom: 'auto',
  // Same size as the reply text around the diagram.
  fontSize: 14,
  sanitize: (svg) => sanitizeDiagramSvg(svg),
}

const FULLSCREEN_OPTIONS: MountOptions = { ...OPTIONS, zoom: { always: true, maxScale: 4 } }

function reason(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return text.split('\n')[0].trim() || 'The diagram could not be drawn.'
}

type View = 'diagram' | 'code'

const TOGGLE_CLASS = 'h-5 rounded-xs px-1.5 text-[11px] font-medium text-(--color-text-muted) hover:text-(--color-text) aria-pressed:bg-(--bg-card) aria-pressed:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'

const HEADER_BUTTON_CLASS = 'flex h-7 w-7 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-6 md:w-6 md:rounded-xs md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100'

function MermaidFullscreen({ source, onClose }: { source: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Esc and app-level switches (⌘K, session change) close it.
  useKeyLayer(true, { kind: 'overlay', closeOnSwitch: true, onClose })

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let mounted: Mounted | null = null
    loadPele()
      .then((lib) => (cancelled ? null : lib.mountAsync(host, source, FULLSCREEN_OPTIONS)))
      .then((result) => {
        if (!result) return
        if (cancelled) result.destroy()
        else mounted = result
      }, () => {})
    return () => {
      cancelled = true
      mounted?.destroy()
      host.replaceChildren()
    }
  }, [source])

  return createPortal(
    <div
      className="mobile-safe-overlay fixed inset-0 z-50 flex flex-col bg-(--color-overlay) backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid diagram full screen"
      data-swipe-ignore
    >
      <div
        className="flex w-full shrink-0 items-center justify-between gap-2 px-[max(1rem,env(safe-area-inset-right,0px))] pt-[max(1rem,env(safe-area-inset-top,0px))] pb-2 [[data-mobile-shell='ios']_&]:pt-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="rounded-xs bg-(--bg-card) px-2 py-1 font-mono label-caps text-(--color-text-muted)">mermaid</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full screen"
          title="Close (Esc)"
          className="flex h-9 w-9 items-center justify-center rounded-md bg-(--bg-card) text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 focus-visible:outline-none"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] sm:px-6 sm:pb-6">
        <div
          className="oa-diagram max-h-full w-full max-w-[1400px] overflow-auto bg-(--bg-card) p-3 sm:p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div ref={hostRef} className="w-full" />
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function MermaidBlock({ source }: { source: string }) {
  const [view, setView] = useState<View>('diagram')
  const [state, setState] = useState<{ status: 'loading' | 'ready' } | { status: 'error'; reason: string }>({ status: 'loading' })
  const [copied, setCopied] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const chatMenu = useChatMenu('Actions for mermaid diagram', () => [{ label: 'Copy code', run: () => copyText(source) }])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let mounted: Mounted | null = null
    setState({ status: 'loading' })
    const fail = (cause: unknown) => {
      if (!cancelled) setState({ status: 'error', reason: reason(cause) })
    }
    loadPele()
      .then((lib) => (cancelled ? null : lib.mountAsync(host, source, OPTIONS)))
      .then((result) => {
        if (!result) return
        if (cancelled) {
          result.destroy()
          return
        }
        mounted = result
        if (result.result) setState({ status: 'ready' })
        else fail(result.error)
      }, fail)
    return () => {
      cancelled = true
      mounted?.destroy()
      host.replaceChildren()
    }
  }, [source])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const failed = state.status === 'error'
  const showCode = view === 'code' || failed

  return (
    <div
      data-slot="mermaid-block"
      onContextMenu={chatMenu.onContextMenu}
      onKeyDown={chatMenu.onKeyDown}
      className="group relative my-1.5 overflow-hidden bg-(--bg-card)"
    >
      <div className="flex items-center justify-between gap-3 bg-(--bg-key) py-0.5 pr-1.5 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono label-caps text-(--color-text-muted)">mermaid</span>
          {!failed && (
            <div role="group" aria-label="Mermaid view" className="flex items-center gap-0.5">
              <button type="button" aria-pressed={view === 'diagram'} onClick={() => setView('diagram')} className={TOGGLE_CLASS}>Diagram</button>
              <button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')} className={TOGGLE_CLASS}>Code</button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {!showCode && state.status === 'ready' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" onClick={() => setFullscreen(true)} className={HEADER_BUTTON_CLASS} aria-label="Full screen">
                    <Maximize2 size={13} />
                  </button>
                }
              />
              <TooltipContent>Full screen</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(source).then(() => setCopied(true), () => {})}
                  className={HEADER_BUTTON_CLASS}
                  aria-label="Copy code"
                >
                  {copied ? <Check size={13} className="text-(--color-success)" /> : <Copy size={13} />}
                </button>
              }
            />
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {failed && (
        <p role="alert" className="flex items-center gap-1.5 border-b border-(--color-border-subtle) px-3 py-1.5 text-xs text-(--color-text-muted)">
          <AlertCircle size={12} aria-hidden="true" className="shrink-0 text-(--color-error)" />
          <span className="min-w-0 break-words">Couldn’t draw this diagram: {state.reason}</span>
        </p>
      )}
      <div hidden={showCode} className="oa-diagram relative px-3 py-3" aria-busy={state.status === 'loading'}>
        {state.status === 'loading' && (
          <p className="py-6 text-center text-xs text-(--color-text-muted)">Drawing diagram…</p>
        )}
        {/* Pele owns this element's children and sizes the diagram to its width. */}
        <div ref={hostRef} className="w-full" />
      </div>
      {showCode && (
        <pre className="overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed text-(--color-text)">
          <code>{source}</code>
        </pre>
      )}
      {chatMenu.menu}
      {fullscreen && <MermaidFullscreen source={source} onClose={() => setFullscreen(false)} />}
    </div>
  )
}

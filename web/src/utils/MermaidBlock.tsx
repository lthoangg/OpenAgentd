import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Copy, Maximize2, X } from 'lucide-react'
import { CodeBlock } from '@/components/CodeBlock'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useThemePreference } from '@/hooks/useThemePreference'
import { usePanZoom } from '@/hooks/use-pan-zoom'
import { usePlatform } from '@/hooks/use-platform'

interface MermaidBlockProps {
  source: string
  highlightedCode: React.ReactNode
}

type RenderState =
  | { status: 'loading'; svg?: string }
  | { status: 'ready'; svg: string }
  | { status: 'error' }

const svgCache = new Map<string, string>()
const MAX_CACHE_SIZE = 100

// eslint-disable-next-line react-refresh/only-export-components
export function clearSvgCache(): void {
  svgCache.clear()
}

function getCacheKey(source: string, theme: string): string {
  return `${theme}:${source}`
}

function getCachedSvg(source: string, theme: string): string | undefined {
  return svgCache.get(getCacheKey(source, theme))
}

function setCachedSvg(source: string, theme: string, svg: string): void {
  if (svgCache.size >= MAX_CACHE_SIZE) {
    const firstKey = svgCache.keys().next().value
    if (firstKey !== undefined) {
      svgCache.delete(firstKey)
    }
  }
  svgCache.set(getCacheKey(source, theme), svg)
}

const FONT_FAMILY = "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

const BASE_THEME_VARS = {
  fontSize: '12px',
  fontFamily: FONT_FAMILY,
}

const LIGHT_THEME_VARS = {
  ...BASE_THEME_VARS,
  darkMode: false,
  primaryColor: '#F5EBD8',
  primaryTextColor: '#1A1714',
  primaryBorderColor: '#B8A47E',
  secondaryColor: '#FFF1D8',
  secondaryTextColor: '#4B3E32',
  secondaryBorderColor: '#B8A47E',
  tertiaryColor: '#FAF6EC',
  tertiaryTextColor: '#6E604F',
  tertiaryBorderColor: '#D9CFA9',
  background: '#FFFBF1',
  mainBkg: '#F5EBD8',
  secondBkg: '#FFF1D8',
  clusterBkg: '#FAF6EC',
  clusterBorder: '#D9CFA9',
  lineColor: '#6E604F',
  defaultLinkColor: '#6E604F',
  transitionColor: '#6E604F',
  textColor: '#1A1714',
  titleColor: '#1A1714',
  edgeLabelBackground: '#FFFDF7',
  actorBkg: '#F0E9D4',
  actorBorder: '#B8A47E',
  actorTextColor: '#1A1714',
  actorLineColor: '#D9CFA9',
  signalColor: '#6E604F',
  signalTextColor: '#1A1714',
  labelBoxBkgColor: '#F0E9D4',
  labelBoxBorderColor: '#B8A47E',
  labelTextColor: '#1A1714',
  loopTextColor: '#6E604F',
  activationBkgColor: '#F5EBD8',
  activationBorderColor: '#B8A47E',
  noteBkgColor: '#FFF1D8',
  noteTextColor: '#873E05',
  noteBorderColor: '#B8A47E',
  classText: '#1A1714',
  git0: '#5AA8E2',
  git1: '#3DA66A',
  git2: '#F59E3B',
  git3: '#A21D52',
  gitBranchLabel0: '#174A73',
  gitBranchLabel1: '#15573D',
  gitBranchLabel2: '#873E05',
  gitBranchLabel3: '#FBE0EB',
  pie1: '#5AA8E2',
  pie2: '#3DA66A',
  pie3: '#F59E3B',
  pie4: '#A21D52',
  pie5: '#5A34D1',
  pie6: '#A71C24',
  pieTitleTextSize: '14px',
  pieTitleTextColor: '#1A1714',
  pieSectionTextSize: '11px',
  pieSectionTextColor: '#1A1714',
  pieLegendTextSize: '11px',
  pieLegendTextColor: '#4B3E32',
  pieStrokeColor: '#FFFBF1',
  pieStrokeWidth: '2px',
}

const DARK_THEME_VARS = {
  ...BASE_THEME_VARS,
  darkMode: true,
  primaryColor: '#2A2219',
  primaryTextColor: '#F5EBD8',
  primaryBorderColor: '#5C4B36',
  secondaryColor: '#221C16',
  secondaryTextColor: '#C5B59A',
  secondaryBorderColor: '#5C4B36',
  tertiaryColor: '#15110D',
  tertiaryTextColor: '#9C8A72',
  tertiaryBorderColor: '#3A2F23',
  background: '#1C1813',
  mainBkg: '#2A2219',
  secondBkg: '#221C16',
  clusterBkg: '#15110D',
  clusterBorder: '#3A2F23',
  lineColor: '#9C8A72',
  defaultLinkColor: '#9C8A72',
  transitionColor: '#9C8A72',
  textColor: '#F5EBD8',
  titleColor: '#F5EBD8',
  edgeLabelBackground: '#1C1813',
  actorBkg: '#2A2219',
  actorBorder: '#5C4B36',
  actorTextColor: '#F5EBD8',
  actorLineColor: '#3A2F23',
  signalColor: '#9C8A72',
  signalTextColor: '#F5EBD8',
  labelBoxBkgColor: '#2A2219',
  labelBoxBorderColor: '#5C4B36',
  labelTextColor: '#F5EBD8',
  loopTextColor: '#9C8A72',
  activationBkgColor: '#2A2219',
  activationBorderColor: '#5C4B36',
  noteBkgColor: '#2A2219',
  noteTextColor: '#F59E3B',
  noteBorderColor: '#5C4B36',
  classText: '#F5EBD8',
  git0: '#7CC2F0',
  git1: '#5ECA88',
  git2: '#F59E3B',
  git3: '#E57BB0',
  gitBranchLabel0: '#174A73',
  gitBranchLabel1: '#15573D',
  gitBranchLabel2: '#873E05',
  gitBranchLabel3: '#FBE0EB',
  pie1: '#7CC2F0',
  pie2: '#5ECA88',
  pie3: '#F59E3B',
  pie4: '#E57BB0',
  pie5: '#A185F8',
  pie6: '#F87171',
  pieTitleTextSize: '14px',
  pieTitleTextColor: '#F5EBD8',
  pieSectionTextSize: '11px',
  pieSectionTextColor: '#15110D',
  pieLegendTextSize: '11px',
  pieLegendTextColor: '#C5B59A',
  pieStrokeColor: '#1C1813',
  pieStrokeWidth: '2px',
}

let renderQueue = Promise.resolve()
let renderSequence = 0
let mermaidInstance: typeof import('mermaid').default | null = null
let lastInitializedTheme: 'light' | 'dark' | null = null

async function getMermaidInstance() {
  if (!mermaidInstance) {
    const mod = await import('mermaid')
    mermaidInstance = mod.default
  }
  return mermaidInstance
}

async function renderDiagram(id: string, source: string, theme: 'light' | 'dark'): Promise<string> {
  let svg = ''
  const task = renderQueue.then(async () => {
    const mermaid = await getMermaidInstance()
    if (lastInitializedTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: theme === 'dark' ? DARK_THEME_VARS : LIGHT_THEME_VARS,
      })
      lastInitializedTheme = theme
    }
    const result = await mermaid.render(`${id}-${++renderSequence}`, source)
    svg = result.svg
  })
  renderQueue = task.catch(() => undefined)
  await task
  return svg
}

interface MermaidLightboxProps {
  onClose: () => void
  svg: string
  source: string
}

function LightboxButton({
  label,
  title,
  icon,
  onClick,
}: {
  label: string
  title: string
  icon: ReactNode
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none sm:h-9 sm:w-9"
          >
            {icon}
          </button>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

export function MermaidLightbox({ onClose, svg, source }: MermaidLightboxProps) {
  const [copied, setCopied] = useState(false)
  const diagramRef = useRef<HTMLDivElement>(null)
  const { isMacOverlay } = usePlatform()
  const { zoomIn, zoomOut, reset, bind } = usePanZoom(diagramRef, { wheelSensitivity: 0.001 })

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Best-effort copy
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn() }
      else if (e.key === '-') { e.preventDefault(); zoomOut() }
      else if (e.key === '0') { e.preventDefault(); reset() }
    }

    document.addEventListener('keydown', handleKeyDown)
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalOverflow
    }
  }, [onClose, reset, zoomIn, zoomOut])

  return createPortal(
    <div
      className="mobile-safe-overlay fixed inset-0 z-50 flex select-none flex-col items-center justify-center bg-black/80 p-2 transition-opacity duration-150 backdrop-blur-xs sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid diagram full screen"
      data-swipe-ignore
    >
      <header
        className={`mobile-safe-header fixed inset-x-0 z-20 flex h-(--spacing-app-header) items-center justify-between gap-2 bg-gradient-to-b from-black/90 via-black/60 to-transparent pr-[max(0.5rem,env(safe-area-inset-right,0px))] ${isMacOverlay ? 'top-(--spacing-app-header) pl-2' : 'top-0 pl-[max(0.5rem,env(safe-area-inset-left,0px))]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="shrink-0 font-mono text-xs font-semibold uppercase tracking-wider text-white/80">
          Mermaid Diagram
        </span>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <LightboxButton
            label="Copy code"
            title="Copy source"
            icon={copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
            onClick={handleCopy}
          />
          <LightboxButton label="Close full screen" title="Close (Esc)" icon={<X size={17} />} onClick={onClose} />
        </div>
      </header>

      <div
        className="surface-raised relative mt-12 sm:mt-10 flex h-[82vh] sm:h-[85vh] w-[96vw] sm:w-[95vw] max-w-[1400px] items-center justify-center overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-card) p-3 sm:p-6 shadow-2xl oa-mermaid-lightbox-content"
        onClick={(e) => e.stopPropagation()}
        data-swipe-ignore
      >
        <div
          ref={diagramRef}
          {...bind}
          className="flex h-full w-full touch-none items-center justify-center"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body,
  )
}

export function MermaidBlock({ source, highlightedCode }: MermaidBlockProps) {
  const [view, setView] = useState('diagram')
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const { resolved: theme } = useThemePreference()
  const [copied, setCopied] = useState(false)
  const reactId = useId()
  const renderId = `oa-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  const cachedSvg = getCachedSvg(source, theme)
  const [renderState, setRenderState] = useState<RenderState>(() =>
    cachedSvg ? { status: 'ready', svg: cachedSvg } : { status: 'loading' }
  )

  useEffect(() => {
    const cached = getCachedSvg(source, theme)
    if (cached) {
      setRenderState((current) =>
        current.status === 'ready' && current.svg === cached
          ? current
          : { status: 'ready', svg: cached }
      )
      return
    }

    let active = true
    setRenderState({ status: 'loading' })

    void renderDiagram(renderId, source, theme)
      .then((svg) => {
        if (!active) return
        setCachedSvg(source, theme, svg)
        setRenderState({ status: 'ready', svg })
      })
      .catch(() => {
        if (!active) return
        setRenderState({ status: 'error' })
      })

    return () => {
      active = false
    }
  }, [renderId, source, theme])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access is best-effort.
    }
  }

  return (
    <div className="surface-raised group my-1.5 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)">
      <Tabs value={view} onValueChange={setView} className="gap-0">
        <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--bg-key) py-0.5 pr-1.5 pl-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
              Mermaid
            </span>
            <TabsList aria-label="Mermaid block view" className="h-6 border-0 bg-transparent p-0">
              <TabsTrigger value="diagram" className="h-6 px-2 text-[11px]">Diagram</TabsTrigger>
              <TabsTrigger value="code" className="h-6 px-2 text-[11px]">Code</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex items-center gap-1">
            {renderState.status === 'ready' && (
              <Tooltip>
              <TooltipTrigger render={
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="flex h-11 w-11 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                aria-label="Full screen"
              >
                <Maximize2 size={13} />
              </button>
              } />
              <TooltipContent>Full screen</TooltipContent>
              </Tooltip>
              )}
              <Tooltip>
              <TooltipTrigger render={
              <button
                type="button"
                onClick={handleCopy}
                className="flex h-11 w-11 items-center justify-center rounded-md text-(--color-text-muted) opacity-100 transition-all hover:bg-(--bg-key) hover:text-(--color-text-2) md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                aria-label="Copy code"
              >
              {copied ? (
                <Check size={13} className="text-(--color-success)" />
              ) : (
                <Copy size={13} />
              )}
              </button>
              } />
              <TooltipContent>Copy</TooltipContent>
              </Tooltip>
          </div>
        </div>

        <TabsContent value="diagram" className="m-0">
          {renderState.status === 'error' ? (
            <div>
              <div role="alert" className="flex items-center gap-2 px-3 py-2.5 text-xs text-(--color-error)">
                <AlertCircle size={14} aria-hidden="true" />
                Could not render this Mermaid diagram. The source is shown below.
              </div>
              <CodeBlock rawText={source} noHeader>{highlightedCode}</CodeBlock>
            </div>
          ) : (
            <div className="oa-mermaid-diagram" aria-busy={renderState.status === 'loading'}>
              {renderState.svg ? (
                <div dangerouslySetInnerHTML={{ __html: renderState.svg }} />
              ) : (
                <div className="px-3 py-8 text-center text-xs text-(--color-text-muted)">
                  Rendering diagram...
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="code" className="m-0">
          <CodeBlock rawText={source} noHeader>{highlightedCode}</CodeBlock>
        </TabsContent>
      </Tabs>

      {renderState.status === 'ready' && fullscreenOpen && (
        <MermaidLightbox
          onClose={() => setFullscreenOpen(false)}
          svg={renderState.svg}
          source={source}
        />
      )}
    </div>
  )
}

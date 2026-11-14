import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppBridge,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core'
import {
  type CallToolResult,
  type JSONRPCMessage,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type Resource,
  type Tool,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/client'
import { ExternalLink, Maximize2, X } from 'lucide-react'
import { callMcpAppTool, issueMcpAppFrameUrl, updateMcpAppModelContext, updateMcpAppStorage } from '@/api/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useKeyLayer } from '@/lib/keyboard/hooks'
import { frameKeyForwarderScript, frameKeymap, useFrameKeys } from '@/lib/keyboard/frames'
import { getPlatform } from '@/hooks/use-platform'
import { openExternalUrl } from '@/lib/open-external'

interface MCPAppPayload {
  server?: string
  tool?: string
  name?: string
  resourceUri?: string
  /** The app's page, on results stored before pages were kept on the server. */
  html?: string
  /** The page is on the server; the frame loads it by a single-use address. */
  html_sha256?: string
  mimeType?: string
  resourceMeta?: { ui?: MCPAppResourceUi; [key: string]: unknown } | null
  toolMeta?: MCPAppToolUi | null
  tool_input?: Record<string, unknown>
  result?: CallToolResult
}

interface MCPAppToolUi {
  resourceUri?: string
  [key: string]: unknown
}

interface MCPAppResourceUi {
  csp?: McpUiResourceCsp
  permissions?: McpUiResourcePermissions
  prefersBorder?: boolean
  [key: string]: unknown
}

interface MCPAppResultProps {
  mcpApp: MCPAppPayload
  sessionId?: string
  toolCallId?: string
}

const HOST_INFO = { name: 'OpenAgentd', version: '1.0.0' }
const DEFAULT_HEIGHT = 420
const MAX_HEIGHT = 900
const INLINE_DISPLAY_MODE = 'inline' as const
const FULLSCREEN_DISPLAY_MODE = 'fullscreen' as const
const THEME_CHANGE_EVENT = 'oa-theme-change'
/** An app may attach its handlers a moment after it says it is initialized;
 * tool data sent at once would arrive first and be dropped. */
const TOOL_DATA_DELAY_MS = 300
const APP_STORAGE_NS = 'oa-mcp-app-storage'
/** Writes this close together go to the backend as one request. */
const STORAGE_WRITE_DELAY_MS = 200
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function clampHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_HEIGHT
  return Math.min(Math.max(Math.ceil(height), 180), MAX_HEIGHT)
}

function decodeResourceMeta(mcpApp: MCPAppPayload): MCPAppResourceUi {
  const ui = mcpApp.resourceMeta?.ui
  return ui && typeof ui === 'object' ? ui : {}
}

function asTool(mcpApp: MCPAppPayload): Tool {
  return {
    name: mcpApp.tool ?? mcpApp.name ?? 'mcp_app',
    title: mcpApp.tool ?? mcpApp.name ?? 'MCP App',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: mcpApp.toolMeta ?? { resourceUri: mcpApp.resourceUri } },
  }
}

function asResource(mcpApp: MCPAppPayload): Resource {
  return {
    name: mcpApp.resourceUri ?? 'mcp_app_resource',
    uri: mcpApp.resourceUri ?? 'ui://unknown',
    mimeType: mcpApp.mimeType,
    _meta: mcpApp.resourceMeta ?? undefined,
  }
}

/** A declared CSP source is one token. Anything with a quote, a semicolon, a
 * comma or whitespace could add keywords or whole directives to the policy. */
function cspSources(domains?: string[]): string[] {
  return (domains ?? []).filter((d) => typeof d === 'string' && d.length > 0 && !/[\s;,'"<>]/.test(d))
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function buildCsp(csp?: McpUiResourceCsp): string {
  const resourceDomains = ["'self'", 'blob:', 'data:', ...cspSources(csp?.resourceDomains)]
  const connectDomains = ["'self'", ...cspSources(csp?.connectDomains)]
  const frameDomains = ["'self'", ...cspSources(csp?.frameDomains)]
  const declaredBaseUris = cspSources(csp?.baseUriDomains)
  const baseUriDomains = declaredBaseUris.length ? declaredBaseUris : ["'self'"]
  return [
    "default-src 'none'",
    `script-src ${resourceDomains.join(' ')} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${resourceDomains.join(' ')} 'unsafe-inline'`,
    `img-src ${resourceDomains.join(' ')}`,
    `font-src ${resourceDomains.join(' ')}`,
    `connect-src ${connectDomains.join(' ')}`,
    `frame-src ${frameDomains.join(' ')}`,
    "object-src 'none'",
    `base-uri ${baseUriDomains.join(' ')}`,
  ].join('; ')
}

/**
 * The frame's origin has no storage of its own, so the page gets stand-ins.
 * `localStorage` starts from what the backend kept for the app's server
 * (handed over in `__OA_APP_STORAGE__`) and tells the host about every
 * write, which the host passes on; `sessionStorage` lasts as long as the page.
 */
function storageShimScript(): string {
  return `<script>(function(){var kept=window.__OA_APP_STORAGE__||{};try{delete window.__OA_APP_STORAGE__}catch{}var LIMIT=5242880;function createStorage(seed,persist){var data=new Map(Object.entries(seed));function size(){var n=0;data.forEach(function(v,k){n+=k.length+v.length});return n}function tell(m){if(!persist)return;m.ns='${APP_STORAGE_NS}';m.v=1;try{parent.postMessage(m,'*')}catch{}}return{get length(){return data.size},key:function(index){return Array.from(data.keys())[index]||null},getItem:function(key){key=String(key);return data.has(key)?data.get(key):null},setItem:function(key,value){key=String(key);value=String(value);var old=data.get(key);data.set(key,value);if(size()>LIMIT){if(old===undefined)data.delete(key);else data.set(key,old);throw new DOMException('The quota has been exceeded.','QuotaExceededError')}tell({op:'set',key:key,value:value})},removeItem:function(key){key=String(key);if(data.delete(key))tell({op:'remove',key:key})},clear:function(){data.clear();tell({op:'clear'})}}}[['localStorage',kept,true],['sessionStorage',{},false]].forEach(function(s){try{void window[s[0]]}catch{Object.defineProperty(window,s[0],{value:createStorage(s[1],s[2]),configurable:true})}})})();</script>`
}

/** The host's own scripts for the app's page; they run before the app's. */
function hostHeadScripts(): string {
  // Key presses stay in the frame: forward app shortcuts and Escape the app
  // did not use, so ⌘W and fullscreen Escape work while it has focus.
  const keys = `<script>${frameKeyForwarderScript(frameKeymap(getPlatform().os))}</script>`
  return `${storageShimScript()}${keys}`
}

function wrapAppHtml(html: string, csp?: McpUiResourceCsp): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(csp).replaceAll('"', '&quot;')}">`
  const prefix = `${cspMeta}${hostHeadScripts()}`
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${prefix}`)
  }
  return `<!doctype html><html><head>${prefix}</head><body>${html}</body></html>`
}

function errorToolResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The page is megabytes on older results; it is compared as a string and
 * the rest as JSON. */
function sameApp(a: MCPAppPayload, b: MCPAppPayload): boolean {
  if (a === b) return true
  if (a.html !== b.html) return false
  return JSON.stringify({ ...a, html: undefined }) === JSON.stringify({ ...b, html: undefined })
}

/** Send values one at a time; while one is on its way only the newest waits. */
function sendNewest<T>(send: (value: T) => Promise<void>): (value: T) => void {
  let busy = false
  let waiting: { value: T } | null = null
  return (value) => {
    if (busy) {
      waiting = { value }
      return
    }
    busy = true
    void (async () => {
      let current: { value: T } | null = { value }
      while (current) {
        try {
          await send(current.value)
        } catch (exc) {
          console.debug('[MCP App] model context update failed', exc)
        }
        current = waiting
        waiting = null
      }
      busy = false
    })()
  }
}

type StorageChange = { clear?: boolean; remove?: string[]; set?: Record<string, string> }

/** Collect an app's storage writes and send them in order, a batch at a time. */
function storageWriter(send: (change: StorageChange) => Promise<void>) {
  let pending: { clear: boolean; remove: Set<string>; set: Map<string, string> } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  const run = async () => {
    timer = undefined
    if (busy) return
    busy = true
    while (pending) {
      const batch = pending
      pending = null
      try {
        await send({
          ...(batch.clear ? { clear: true } : {}),
          ...(batch.remove.size ? { remove: [...batch.remove] } : {}),
          ...(batch.set.size ? { set: Object.fromEntries(batch.set) } : {}),
        })
      } catch (exc) {
        console.debug('[MCP App] storage update failed', exc)
      }
    }
    busy = false
  }
  return {
    record(message: { op?: unknown; key?: unknown; value?: unknown }) {
      const { op, key, value } = message
      pending ??= { clear: false, remove: new Set(), set: new Map() }
      if (op === 'clear') {
        pending = { clear: true, remove: new Set(), set: new Map() }
      } else if (op === 'set' && typeof key === 'string' && typeof value === 'string') {
        pending.remove.delete(key)
        pending.set.set(key, value)
      } else if (op === 'remove' && typeof key === 'string') {
        pending.set.delete(key)
        pending.remove.add(key)
      }
      timer ??= setTimeout(() => void run(), STORAGE_WRITE_DELAY_MS)
    },
    /** Send what is waiting now: the panel is going away. */
    flush() {
      if (timer === undefined) return
      clearTimeout(timer)
      void run()
    },
  }
}

class DeferredPostMessageTransport implements Transport {
  private target: Window | null = null
  private closed = false
  private readonly queuedMessages: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = []
  private readonly messageListener: (event: MessageEvent) => void
  private readonly getSource: () => MessageEventSource | null

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  sessionId?: string
  setProtocolVersion?: (version: string) => void

  constructor(getSource: () => MessageEventSource | null) {
    this.getSource = getSource
    this.messageListener = (event) => {
      const source = this.getSource()
      if (source && event.source !== source) return
      if (!source && event.origin !== 'null') return

      const parsed = JSONRPCMessageSchema.safeParse(event.data)
      if (parsed.success) {
        this.onmessage?.(parsed.data)
      } else if (event.data?.jsonrpc === '2.0') {
        this.onerror?.(new Error(`Invalid JSON-RPC message received: ${parsed.error.message}`))
      }
    }
  }

  async start(): Promise<void> {
    window.addEventListener('message', this.messageListener)
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (this.closed) return
    if (!this.target) {
      this.queuedMessages.push({ message, options })
      return
    }
    this.target.postMessage(message, '*')
  }

  setTarget(target: Window): void {
    this.target = target
    const queued = this.queuedMessages.splice(0)
    for (const item of queued) {
      void this.send(item.message, item.options)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.queuedMessages.length = 0
    window.removeEventListener('message', this.messageListener)
    this.onclose?.()
  }
}

export function MCPAppResult({ mcpApp: latest, sessionId, toolCallId }: MCPAppResultProps) {
  // History is rebuilt when a turn ends or the session reloads, which hands
  // over an equal result as new objects. Loading the page again for those
  // would restart the app and drop what it was doing.
  const [mcpApp, setMcpApp] = useState(latest)
  if (mcpApp !== latest && !sameApp(mcpApp, latest)) setMcpApp(latest)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  useFrameKeys(iframeRef)
  const bridgeRef = useRef<AppBridge | null>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [displayMode, setDisplayMode] = useState<typeof INLINE_DISPLAY_MODE | typeof FULLSCREEN_DISPLAY_MODE>(INLINE_DISPLAY_MODE)
  const [error, setError] = useState<string | null>(null)
  const resourceUi = decodeResourceMeta(mcpApp)
  const csp = useMemo(() => resourceUi.csp, [resourceUi.csp])
  const permissions = useMemo(() => resourceUi.permissions, [resourceUi.permissions])
  const title = mcpApp.tool ?? mcpApp.name ?? 'MCP App'
  const resourceUri = (mcpApp.resourceUri ?? resourceUi.resourceUri) as string | undefined
  const updateHostDisplayMode = useCallback((nextMode: typeof INLINE_DISPLAY_MODE | typeof FULLSCREEN_DISPLAY_MODE) => {
    const iframe = iframeRef.current
    bridgeRef.current?.setHostContext({
      displayMode: nextMode,
      containerDimensions: nextMode === FULLSCREEN_DISPLAY_MODE
        ? { height: iframe?.clientHeight || window.innerHeight, width: iframe?.clientWidth || window.innerWidth }
        : { maxHeight: MAX_HEIGHT, width: iframe?.clientWidth ?? 0 },
    })
  }, [])

  useEffect(() => {
    updateHostDisplayMode(displayMode)
  }, [displayMode, updateHostDisplayMode])

  useEffect(() => {
    const syncTheme = () => {
      bridgeRef.current?.setHostContext({ theme: currentTheme() })
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme)
    syncTheme()
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncTheme)
      observer.disconnect()
    }
  }, [])

  useKeyLayer(displayMode === FULLSCREEN_DISPLAY_MODE, {
    kind: 'overlay',
    closeOnSwitch: true,
    onClose: () => setDisplayMode(INLINE_DISPLAY_MODE),
  })

  useEffect(() => {
    if (displayMode !== FULLSCREEN_DISPLAY_MODE) return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [displayMode])

  useEffect(() => {
    const iframe = iframeRef.current
    const inlineHtml = mcpApp.html
    if (!iframe || (!inlineHtml && !mcpApp.html_sha256)) return undefined

    let cancelled = false
    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        logging: {},
        serverTools: {},
        serverResources: {},
        updateModelContext: { text: {}, structuredContent: {} },
        message: { text: {}, structuredContent: {} },
      },
      {
        hostContext: {
          toolInfo: { tool: asTool(mcpApp) },
          theme: currentTheme(),
          platform: 'web',
          displayMode: INLINE_DISPLAY_MODE,
          availableDisplayModes: [INLINE_DISPLAY_MODE, FULLSCREEN_DISPLAY_MODE],
          containerDimensions: { maxHeight: MAX_HEIGHT, width: iframe.clientWidth },
        },
      },
    )
    bridgeRef.current = bridge
    const sendInitialToolData = async () => {
      if (cancelled) return
      await bridge.sendToolInput({ arguments: mcpApp.tool_input ?? {} })
      if (cancelled || !mcpApp.result) return
      await bridge.sendToolResult(mcpApp.result)
    }

    bridge.onsizechange = async ({ height: nextHeight }) => {
      if (typeof nextHeight === 'number') setHeight(clampHeight(nextHeight))
    }
    bridge.onopenlink = async ({ url }) => {
      // An app may open web pages only; other schemes reach the system opener.
      if (!isWebUrl(url)) return { isError: true }
      // window.open is a silent no-op inside Tauri webviews (no tab/popup
      // machinery, especially iOS WKWebView); openExternalUrl routes through
      // tauri-plugin-opener there and falls back to window.open in browsers.
      await openExternalUrl(url)
      return {}
    }
    bridge.onloggingmessage = ({ level, logger, data }) => {
      console.debug('[MCP App]', level, logger, data)
    }
    // The backend keeps each panel's newest report and gives it to the model
    // with the session's next message.
    const reportModelContext = sendNewest(async (params: { content?: unknown[]; structuredContent?: Record<string, unknown> }) => {
      if (!sessionId || !toolCallId) return
      await updateMcpAppModelContext({
        session_id: sessionId,
        tool_call_id: toolCallId,
        ...(params.content ? { content: params.content } : {}),
        ...(params.structuredContent ? { structuredContent: params.structuredContent } : {}),
      })
    })
    bridge.onupdatemodelcontext = async (params) => {
      reportModelContext(params ?? {})
      return {}
    }
    bridge.onmessage = async () => ({})
    // The app's `localStorage` writes, from the stand-in in its page.
    const storage = storageWriter(async (change) => {
      if (!sessionId || !toolCallId) return
      await updateMcpAppStorage({ session_id: sessionId, tool_call_id: toolCallId, ...change })
    })
    const onStorageMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return
      const data = event.data as { ns?: unknown; v?: unknown; op?: unknown; key?: unknown; value?: unknown } | null
      if (data?.ns === APP_STORAGE_NS && data.v === 1) storage.record(data)
    }
    window.addEventListener('message', onStorageMessage)
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const nextMode = mode === FULLSCREEN_DISPLAY_MODE ? FULLSCREEN_DISPLAY_MODE : INLINE_DISPLAY_MODE
      setDisplayMode(nextMode)
      return { mode: nextMode }
    }
    let toolDataTimer: ReturnType<typeof setTimeout> | undefined
    bridge.oninitialized = () => {
      clearTimeout(toolDataTimer)
      toolDataTimer = setTimeout(() => {
        void sendInitialToolData().catch((exc) => {
          if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc))
        })
      }, TOOL_DATA_DELAY_MS)
    }
    // Do not expose generic tool listing. The backend authorizes calls against
    // this artifact's persisted session/tool-call binding and the same server's
    // current advertised tool list before invoking anything.
    bridge.oncalltool = async ({ name, arguments: args }): Promise<CallToolResult> => {
      if (!sessionId || !toolCallId || !mcpApp.server) return errorToolResult('MCP app artifact is missing server/session binding.')
      if (args !== undefined && !isJsonObject(args)) return errorToolResult('MCP app tool arguments must be a JSON object.')
      try {
        const response = await callMcpAppTool({
          session_id: sessionId,
          tool_call_id: toolCallId,
          server: mcpApp.server,
          tool: name,
          arguments: args ?? {},
        })
        return response.result as CallToolResult
      } catch (exc) {
        return errorToolResult(exc instanceof Error ? exc.message : 'MCP app tool call failed.')
      }
    }
    bridge.onlistresources = async (): Promise<ListResourcesResult> => ({
      resources: resourceUri ? [asResource(mcpApp)] : [],
    })
    bridge.onlistresourcetemplates = async (): Promise<ListResourceTemplatesResult> => ({
      resourceTemplates: [],
    })
    bridge.onreadresource = async ({ uri }): Promise<ReadResourceResult> => {
      if (uri !== resourceUri || !inlineHtml) return { contents: [] }
      return {
        contents: [{
          uri,
          mimeType: mcpApp.mimeType,
          text: inlineHtml,
          _meta: mcpApp.resourceMeta ?? undefined,
        }] as unknown as ReadResourceResult['contents'],
      }
    }

    // No allow-same-origin: a srcdoc frame would get this page's origin, and
    // with it the page's storage, API access and DOM. The app runs in its own
    // origin and talks to the host through postMessage only.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms')
    const allow = buildAllowAttribute(permissions)
    if (allow) iframe.setAttribute('allow', allow)

    const transport = new DeferredPostMessageTransport(() => iframe.contentWindow)

    let removeLoadListener: (() => void) | undefined
    const initialize = async () => {
      try {
        await bridge.connect(transport)
        const attachTarget = () => {
          if (iframe.contentWindow) transport.setTarget(iframe.contentWindow)
        }
        iframe.addEventListener('load', attachTarget)
        removeLoadListener = () => iframe.removeEventListener('load', attachTarget)
        // A stored result's page comes from the backend by a single-use
        // address, which gives the page a real URL and its policy as a
        // header. Inline HTML (an unbound result, or a backend that has no
        // such address) is written into the frame instead.
        let frameUrl: string | null = null
        if (sessionId && toolCallId) {
          try {
            frameUrl = await issueMcpAppFrameUrl({ session_id: sessionId, tool_call_id: toolCallId, head: hostHeadScripts() })
          } catch (exc) {
            if (!inlineHtml) throw exc
          }
        }
        if (cancelled) return
        if (frameUrl) iframe.src = frameUrl
        else if (inlineHtml) iframe.srcdoc = wrapAppHtml(inlineHtml, csp ?? undefined)
        else throw new Error('MCP app page is not available.')
        attachTarget()
      } catch (exc) {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc))
      }
    }
    void initialize()

    return () => {
      cancelled = true
      clearTimeout(toolDataTimer)
      window.removeEventListener('message', onStorageMessage)
      storage.flush()
      removeLoadListener?.()
      bridgeRef.current = null
      void bridge.close().catch(() => undefined)
    }
  }, [csp, mcpApp, permissions, resourceUri, sessionId, toolCallId])

  if (!mcpApp.html && !mcpApp.html_sha256) {
    return <p className="font-mono text-meta text-(--color-error)">MCP app resource did not include HTML.</p>
  }

  const isFullscreen = displayMode === FULLSCREEN_DISPLAY_MODE
  const iframe = (
    <iframe
      ref={iframeRef}
      title={title}
      className={isFullscreen ? 'h-full w-full bg-(--bg-page)' : 'w-full rounded-md border border-(--color-border) bg-(--bg-page)'}
      style={isFullscreen ? undefined : { height }}
    />
  )

  return (
    <div
      className={isFullscreen ? "below-window-caption fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-(--bg-page) [[data-mobile-shell]_&]:pt-[env(safe-area-inset-top)] [[data-mobile-shell]_&]:pb-[env(safe-area-inset-bottom)] [[data-mobile-shell]_&]:pl-[env(safe-area-inset-left)] [[data-mobile-shell]_&]:pr-[env(safe-area-inset-right)]" : 'flex flex-col gap-2'}
      {...(isFullscreen ? { 'data-swipe-ignore': true } : {})}
    >
      <div className={isFullscreen ? 'hidden' : 'flex items-center justify-between gap-2 font-mono text-xs md:text-meta text-(--color-text-muted)'}>
        {resourceUri ? (
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<span className="min-w-0 truncate">{title}{` · ${String(resourceUri)}`}</span>}
            />
            <TooltipContent>{String(resourceUri)}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <button
          type="button"
          onClick={() => setDisplayMode(FULLSCREEN_DISPLAY_MODE)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-(--bg-key) px-1.5 py-0.5 text-xs md:text-meta uppercase tracking-wide transition-colors hover:bg-(--color-fill-key-hover) focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
          aria-label={`Open ${title} fullscreen`}
        >
          <Maximize2 size={12} aria-hidden /> MCP App
        </button>
      </div>
      {error && (
        <p className="rounded-md border border-(--color-error) px-2 py-1 font-mono text-xs md:text-meta text-(--color-error)">
          MCP app bridge error: {error}
        </p>
      )}
      <div
        className={isFullscreen ? 'flex min-h-0 flex-1 flex-col' : undefined}
        role={isFullscreen ? 'dialog' : undefined}
        aria-modal={isFullscreen ? 'true' : undefined}
        aria-label={isFullscreen ? `${title} fullscreen MCP app` : undefined}
      >
        <div className={isFullscreen ? 'min-h-0 flex-1 overflow-hidden' : undefined}>
          {iframe}
        </div>
        {isFullscreen ? (
          <button
            type="button"
            onClick={() => setDisplayMode(INLINE_DISPLAY_MODE)}
            className="absolute right-4 top-4 flex h-9 w-9 cursor-pointer items-center justify-center rounded-sm bg-(--bg-card) text-(--color-text) shadow-(--shadow-depth) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none [[data-mobile-shell]_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
            aria-label="Close fullscreen MCP app"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      <p className={isFullscreen ? 'hidden' : 'flex items-center gap-1 font-mono text-xs md:text-meta text-(--color-text-muted)'}>
        <ExternalLink size={12} aria-hidden />
        Experimental sandbox: app can render and receive the initial tool input/result; app tool calls stay bound to this artifact and its MCP server's current advertised tools.
      </p>
    </div>
  )
}

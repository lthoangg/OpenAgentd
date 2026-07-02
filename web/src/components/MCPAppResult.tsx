import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppBridge,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import {
  JSONRPCMessageSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ExternalLink, Maximize2, X } from 'lucide-react'
import { callMcpAppTool } from '@/api/client'
import { openExternalUrl } from '@/lib/open-external'

interface MCPAppPayload {
  server?: string
  tool?: string
  name?: string
  resourceUri?: string
  html?: string
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

function buildCsp(csp?: McpUiResourceCsp): string {
  const resourceDomains = ["'self'", 'blob:', 'data:', ...(csp?.resourceDomains ?? [])]
  const connectDomains = ["'self'", ...(csp?.connectDomains ?? [])]
  const frameDomains = ["'self'", ...(csp?.frameDomains ?? [])]
  const baseUriDomains = csp?.baseUriDomains?.length ? csp.baseUriDomains : ["'self'"]
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

function storageShimScript(): string {
  return `<script>(function(){function createStorage(){var data=new Map();return{get length(){return data.size},key:function(index){return Array.from(data.keys())[index]||null},getItem:function(key){key=String(key);return data.has(key)?data.get(key):null},setItem:function(key,value){data.set(String(key),String(value))},removeItem:function(key){data.delete(String(key))},clear:function(){data.clear()}}}['localStorage','sessionStorage'].forEach(function(name){try{void window[name]}catch{Object.defineProperty(window,name,{value:createStorage(),configurable:true})}})})();</script>`
}

function wrapAppHtml(html: string, csp?: McpUiResourceCsp): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(csp).replaceAll('"', '&quot;')}">`
  const prefix = `${cspMeta}${storageShimScript()}`
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

export function MCPAppResult({ mcpApp, sessionId, toolCallId }: MCPAppResultProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
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

  useEffect(() => {
    if (displayMode !== FULLSCREEN_DISPLAY_MODE) return undefined

    const previousOverflow = document.body.style.overflow
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDisplayMode(INLINE_DISPLAY_MODE)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleEscape)
    }
  }, [displayMode])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !mcpApp.html) return undefined

    let cancelled = false
    const html = mcpApp.html
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
      // window.open is a silent no-op inside Tauri webviews (no tab/popup
      // machinery, especially iOS WKWebView); openExternalUrl routes through
      // tauri-plugin-opener there and falls back to window.open in browsers.
      await openExternalUrl(url)
      return {}
    }
    bridge.onloggingmessage = ({ level, logger, data }) => {
      console.debug('[MCP App]', level, logger, data)
    }
    bridge.onupdatemodelcontext = async () => ({})
    bridge.onmessage = async () => ({})
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const nextMode = mode === FULLSCREEN_DISPLAY_MODE ? FULLSCREEN_DISPLAY_MODE : INLINE_DISPLAY_MODE
      setDisplayMode(nextMode)
      return { mode: nextMode }
    }
    bridge.oninitialized = () => {
      void sendInitialToolData().catch((exc) => {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc))
      })
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
      if (uri !== resourceUri) return { contents: [] }
      return {
        contents: [{
          uri,
          mimeType: mcpApp.mimeType,
          text: mcpApp.html ?? '',
          _meta: mcpApp.resourceMeta ?? undefined,
        }] as unknown as ReadResourceResult['contents'],
      }
    }

    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
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
        iframe.srcdoc = wrapAppHtml(html, csp ?? undefined)
        attachTarget()
      } catch (exc) {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc))
      }
    }
    void initialize()

    return () => {
      cancelled = true
      removeLoadListener?.()
      bridgeRef.current = null
      void bridge.close().catch(() => undefined)
    }
  }, [csp, mcpApp, permissions, resourceUri, sessionId, toolCallId])

  if (!mcpApp.html) {
    return <p className="font-mono text-[11px] text-(--color-error)">MCP app resource did not include HTML.</p>
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
      className={isFullscreen ? "fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-(--bg-page) [[data-mobile-shell]_&]:pt-[env(safe-area-inset-top)] [[data-mobile-shell]_&]:pb-[env(safe-area-inset-bottom)] [[data-mobile-shell]_&]:pl-[env(safe-area-inset-left)] [[data-mobile-shell]_&]:pr-[env(safe-area-inset-right)]" : 'flex flex-col gap-2'}
      {...(isFullscreen ? { 'data-swipe-ignore': true } : {})}
    >
      <div className={isFullscreen ? 'hidden' : 'flex items-center justify-between gap-2 font-mono text-[10px] text-(--color-text-muted)'}>
        <span className="min-w-0 truncate" title={resourceUri}>{title}{resourceUri ? ` · ${String(resourceUri)}` : ''}</span>
        <button
          type="button"
          onClick={() => setDisplayMode(FULLSCREEN_DISPLAY_MODE)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-(--color-border) px-1.5 py-0.5 text-[9px] uppercase tracking-wide transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
          aria-label={`Open ${title} fullscreen`}
        >
          <Maximize2 size={9} aria-hidden /> MCP App
        </button>
      </div>
      {error && (
        <p className="rounded-md border border-(--color-error) px-2 py-1 font-mono text-[10px] text-(--color-error)">
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
            className="absolute right-4 top-4 flex h-10 w-10 cursor-pointer items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-card) text-(--color-text) transition-colors hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-text) focus-visible:outline-none [[data-mobile-shell='ios']_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]"
            aria-label="Close fullscreen MCP app"
          >
            <X size={20} aria-hidden />
          </button>
        ) : null}
      </div>
      <p className={isFullscreen ? 'hidden' : 'flex items-center gap-1 font-mono text-[10px] text-(--color-text-muted)'}>
        <ExternalLink size={10} aria-hidden />
        Experimental sandbox: app can render and receive the initial tool input/result; app tool calls stay bound to this artifact and its MCP server's current advertised tools.
      </p>
    </div>
  )
}

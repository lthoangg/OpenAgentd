import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from "bun:test"
import { act, render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom"
import { MCPAppResult } from "@/components/MCPAppResult"
import { FRAME_KEYS_NS } from "@/lib/keyboard/frames"

const callMcpAppTool = mock(async () => ({ result: { content: [{ type: "text", text: "saved" }] } }))
const issueMcpAppFrameUrl = mock(async (..._args: unknown[]) => "about:blank?frame=ticket-1")
const updateMcpAppModelContext = mock(async (..._args: unknown[]): Promise<void> => undefined)

afterEach(cleanup)

const bridgeInstances: MockBridge[] = []

class MockBridge {
  static lastTransport: unknown

  onsizechange?: (params: { height?: number }) => Promise<void>
  onopenlink?: (params: { url: string }) => Promise<Record<string, unknown>>
  onloggingmessage?: (params: { level: string; logger?: string; data?: unknown }) => void
  onupdatemodelcontext?: (params: { content?: unknown[]; structuredContent?: Record<string, unknown> }) => Promise<Record<string, unknown>>
  onmessage?: () => Promise<Record<string, unknown>>
  onrequestdisplaymode?: (params: { mode: string }) => Promise<{ mode: string }>
  oninitialized?: () => void
  oncalltool?: (params: { name: string; arguments?: unknown }) => Promise<unknown>
  onlistresources?: () => Promise<unknown>
  onlistresourcetemplates?: () => Promise<unknown>
  onreadresource?: (params: { uri: string }) => Promise<unknown>

  sendToolInput = mock(async () => undefined)
  sendToolResult = mock(async () => undefined)
  setHostContext = mock(() => undefined)
  close = mock(async () => undefined)
  connect = mock(async (transport: unknown) => {
    MockBridge.lastTransport = transport
  })

  constructor() {
    bridgeInstances.push(this)
  }
}

mock.module("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: MockBridge,
  buildAllowAttribute: () => "clipboard-write",
}))

mock.module("@/api/client", () => ({
  callMcpAppTool,
  issueMcpAppFrameUrl,
  updateMcpAppModelContext,
}))



describe("MCPAppResult", () => {
  beforeEach(() => {
    bridgeInstances.length = 0
    MockBridge.lastTransport = undefined
    document.documentElement.className = ""
  })

  afterEach(() => {
    bridgeInstances.length = 0
    MockBridge.lastTransport = undefined
    callMcpAppTool.mockClear()
    callMcpAppTool.mockImplementation(async () => ({ result: { content: [{ type: "text", text: "saved" }] } }))
    issueMcpAppFrameUrl.mockClear()
    issueMcpAppFrameUrl.mockImplementation(async () => "about:blank?frame=ticket-1")
    updateMcpAppModelContext.mockClear()
    updateMcpAppModelContext.mockImplementation(async () => undefined)
    document.documentElement.className = ""
  })

  it("loads a stored result's page from a single-use address, with the host scripts for its head", async () => {
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{
          server: "canvas",
          tool: "exec",
          resourceUri: "ui://canvas/app.html",
          html_sha256: "a".repeat(64),
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("src")).toBe("about:blank?frame=ticket-1"))
    const iframe = document.body.querySelector("iframe")
    expect(iframe?.getAttribute("srcdoc")).toBeNull()
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
    expect(issueMcpAppFrameUrl).toHaveBeenCalledTimes(1)
    const request = issueMcpAppFrameUrl.mock.calls[0][0] as { session_id: string; tool_call_id: string; head: string }
    expect(request.session_id).toBe("session-1")
    expect(request.tool_call_id).toBe("tool-call-1")
    expect(request.head).toContain("function createStorage")
    expect(request.head).toContain(FRAME_KEYS_NS)
    // The server sends the page's policy as a header.
    expect(request.head).not.toContain("Content-Security-Policy")
    expect(screen.queryByText(/MCP app bridge error/)).toBeNull()
  })

  it("renders inline HTML in place when no address can be issued", async () => {
    issueMcpAppFrameUrl.mockImplementation(async () => {
      throw new Error("Not Found")
    })
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{
          server: "canvas",
          tool: "exec",
          resourceUri: "ui://canvas/app.html",
          html: "<html><body>inline app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("inline app"))
    expect(document.body.querySelector("iframe")?.getAttribute("src")).toBeNull()
    expect(document.body.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
  })

  it("says so when a stored page cannot be loaded", async () => {
    issueMcpAppFrameUrl.mockImplementation(async () => {
      throw new Error("MCP app page not found.")
    })
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{ server: "canvas", tool: "exec", resourceUri: "ui://canvas/app.html", html_sha256: "a".repeat(64) }}
      />,
    )

    expect(await screen.findByText("MCP app bridge error: MCP app page not found.")).toBeTruthy()
    expect(document.body.querySelector("iframe")?.getAttribute("src")).toBeNull()
  })

  it("passes what the app reports for the model to the backend, keeping only the newest while one is sent", async () => {
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{ server: "canvas", tool: "exec", resourceUri: "ui://canvas/app.html", html_sha256: "a".repeat(64) }}
      />,
    )
    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())

    let finishFirst: () => void = () => undefined
    let sent = 0
    updateMcpAppModelContext.mockImplementation(() => {
      sent += 1
      return sent === 1 ? new Promise<void>((resolve) => { finishFirst = resolve }) : Promise.resolve()
    })
    const report = (text: string) => bridgeInstances[0]?.onupdatemodelcontext?.({ content: [{ type: "text", text }] })
    expect(await report("1 shape")).toEqual({})
    await report("2 shapes")
    await report("3 shapes")
    expect(updateMcpAppModelContext).toHaveBeenCalledTimes(1)
    finishFirst()

    await waitFor(() => expect(updateMcpAppModelContext).toHaveBeenCalledTimes(2))
    expect(updateMcpAppModelContext.mock.calls.map((call) => call[0])).toEqual([
      { session_id: "session-1", tool_call_id: "tool-call-1", content: [{ type: "text", text: "1 shape" }] },
      { session_id: "session-1", tool_call_id: "tool-call-1", content: [{ type: "text", text: "3 shapes" }] },
    ])
  })

  it("routes open-link requests through openExternalUrl so Tauri shells open the system browser", async () => {
    const openSpy = spyOn(window, "open").mockImplementation(() => null)

    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    await act(async () => {
      await bridgeInstances[0]?.onopenlink?.({ url: "https://excalidraw.com/#json=abc" })
    })

    // Browser fallback path of openExternalUrl (no Tauri runtime in tests);
    // in Tauri shells the same helper routes through tauri-plugin-opener.
    expect(openSpy).toHaveBeenCalledWith("https://excalidraw.com/#json=abc", "_blank", "noopener,noreferrer")
    openSpy.mockRestore()
  })

  it("refuses to open links that are not http or https", async () => {
    const openSpy = spyOn(window, "open").mockImplementation(() => null)

    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "myapp://open?x=1", "not a url"]) {
      const result = await bridgeInstances[0]?.onopenlink?.({ url })
      expect(result).toEqual({ isError: true })
    }

    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it("renders MCP app HTML from srcdoc so production shells avoid blob/data frame quirks", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
          resourceMeta: { ui: { prefersBorder: true, permissions: { clipboardWrite: true } } },
          toolMeta: { resourceUri: "ui://excalidraw/mcp-app.html" },
          tool_input: { title: "diagram" },
          result: { content: [{ type: "text", text: "Draw a diagram" }] },
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("mcp app"))

    const iframe = document.body.querySelector("iframe")
    expect(iframe).toBeTruthy()
    // Without allow-same-origin the frame has its own origin: the app cannot
    // reach window.parent, the host's storage, or the host's API.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(iframe?.getAttribute("allow")).toContain("clipboard-write")
    expect(iframe?.getAttribute("src")).toBeNull()
    expect(iframe?.getAttribute("title")).toBe("create_view")
    expect(screen.getByText(/Experimental sandbox:/)).toBeTruthy()
  })

  it("syncs theme changes to the MCP app bridge", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    bridgeInstances[0]?.setHostContext.mockClear()
    act(() => {
      document.documentElement.classList.add("dark")
      window.dispatchEvent(new CustomEvent("oa-theme-change"))
    })

    expect(bridgeInstances[0]?.setHostContext).toHaveBeenCalledWith({ theme: "dark" })
    document.documentElement.classList.remove("dark")
  })

  it("applies resource CSP domains for externally loaded MCP app modules", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
          resourceMeta: {
            ui: {
              csp: {
                resourceDomains: ["https://esm.sh"],
                connectDomains: ["https://esm.sh"],
              },
            },
          },
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("mcp app"))

    const appHtml = document.body.querySelector("iframe")?.getAttribute("srcdoc") ?? ""
    expect(appHtml).toContain("script-src 'self' blob: data: https://esm.sh 'unsafe-inline' 'unsafe-eval'")
    expect(appHtml).toContain("connect-src 'self' https://esm.sh")
  })

  it("drops declared CSP domains that could add their own policy directives", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
          resourceMeta: {
            ui: {
              csp: {
                connectDomains: ["https://ok.example", "https://a.example; script-src *", "'unsafe-eval'", "https://b.example https://c.example"],
              },
            },
          },
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("mcp app"))

    const appHtml = document.body.querySelector("iframe")?.getAttribute("srcdoc") ?? ""
    expect(appHtml).toContain("connect-src 'self' https://ok.example;")
    expect(appHtml).not.toContain("a.example")
    expect(appHtml).not.toContain("c.example")
  })

  it("injects sandbox-safe storage shims before app scripts run", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: '<html><head></head><body><script type="module">localStorage.getItem("x")</script></body></html>',
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("localStorage"))

    const appHtml = document.body.querySelector("iframe")?.getAttribute("srcdoc") ?? ""
    expect(appHtml.indexOf("function createStorage")).toBeLessThan(appHtml.indexOf('localStorage.getItem("x")'))
    expect(appHtml).toContain("'localStorage','sessionStorage'")
  })

  it("injects the key forwarder so app keys and Escape reach the host", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: '<html><head></head><body><script>boot()</script></body></html>',
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )
    await waitFor(() => expect(document.body.querySelector("iframe")?.getAttribute("srcdoc")).toContain("boot()"))
    const appHtml = document.body.querySelector("iframe")?.getAttribute("srcdoc") ?? ""
    expect(appHtml).toContain(FRAME_KEYS_NS)
    expect(appHtml.indexOf(FRAME_KEYS_NS)).toBeLessThan(appHtml.indexOf("boot()"))
  })

  it("leaves fullscreen when the focused app forwards Escape", async () => {
    const user = userEvent.setup()
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Open create_view fullscreen" }))
    expect(screen.getByRole("dialog", { name: "create_view fullscreen MCP app" })).toBeTruthy()
    const iframe = document.body.querySelector("iframe") as HTMLIFrameElement
    iframe.focus()
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { ns: FRAME_KEYS_NS, v: 1, type: "key", key: "Escape", code: "Escape" },
        source: iframe.contentWindow,
      }))
    })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "create_view fullscreen MCP app" })).toBeNull())
  })

  it("starts the bridge transport before loading app HTML so app initialization is not missed", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
          tool_input: { title: "diagram" },
          result: { content: [{ type: "text", text: "Draw a diagram" }] },
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())

    const iframe = document.body.querySelector("iframe")
    expect(iframe?.getAttribute("srcdoc")).toContain("mcp app")
    expect(MockBridge.lastTransport).toBeTruthy()

    bridgeInstances[0]?.oninitialized?.()

    await waitFor(() => expect(bridgeInstances[0]?.sendToolInput).toHaveBeenCalledWith({ arguments: { title: "diagram" } }))
    expect(bridgeInstances[0]?.sendToolResult).toHaveBeenCalledWith({ content: [{ type: "text", text: "Draw a diagram" }] })
  })

  it("lets users open MCP apps fullscreen from inline mode", async () => {
    const user = userEvent.setup()
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Open create_view fullscreen" }))

    expect(screen.getByRole("dialog", { name: "create_view fullscreen MCP app" })).toBeTruthy()
    expect(bridgeInstances[0]?.setHostContext).toHaveBeenCalledWith({
      displayMode: "fullscreen",
      containerDimensions: { height: window.innerHeight, width: window.innerWidth },
    })
  })

  it("allows MCP apps to request fullscreen edit mode", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    let result: { mode: string } | undefined
    await act(async () => {
      result = await bridgeInstances[0]?.onrequestdisplaymode?.({ mode: "fullscreen" })
    })

    expect(result).toEqual({ mode: "fullscreen" })
    expect(bridgeInstances[0]?.setHostContext).toHaveBeenCalledWith({
      displayMode: "fullscreen",
      containerDimensions: { height: window.innerHeight, width: window.innerWidth },
    })
  })

  it("uses the full viewport in fullscreen mode with safe-area padding on mobile shells", async () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    await act(async () => {
      await bridgeInstances[0]?.onrequestdisplaymode?.({ mode: "fullscreen" })
    })

    const dialog = screen.getByRole("dialog")
    const overlay = dialog.parentElement
    expect(overlay?.className).toContain("fixed inset-0")
    expect(overlay?.className).toContain("min-h-0")
    expect(overlay?.className).toContain("overflow-hidden")
    // Rabbit-ear / notch awareness: safe-area insets applied only under mobile shells.
    expect(overlay?.className).toContain("[[data-mobile-shell]_&]:pt-[env(safe-area-inset-top)]")
    expect(overlay?.className).toContain("[[data-mobile-shell]_&]:pb-[env(safe-area-inset-bottom)]")
    expect(overlay?.className).toContain("[[data-mobile-shell]_&]:pl-[env(safe-area-inset-left)]")
    expect(overlay?.className).toContain("[[data-mobile-shell]_&]:pr-[env(safe-area-inset-right)]")
    // No 90vh/90vw letterboxing — iframe fills the dialog.
    const iframe = document.body.querySelector("iframe")
    expect(iframe?.className).toContain("h-full w-full")
    expect(iframe?.parentElement?.className).toContain("overflow-hidden")
    expect(bridgeInstances[0]?.setHostContext).toHaveBeenCalledWith({
      displayMode: "fullscreen",
      containerDimensions: { height: window.innerHeight, width: window.innerWidth },
    })
    expect(overlay?.className).not.toContain("90vh")
    // Header and sandbox caption are hidden so the app gets 100% of the screen.
    expect(screen.getByText(/Experimental sandbox:/).className).toContain("hidden")
  })

  it("keeps the same iframe mounted when closing fullscreen", async () => {
    const user = userEvent.setup()
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    const iframe = document.body.querySelector("iframe")
    await act(async () => {
      await bridgeInstances[0]?.onrequestdisplaymode?.({ mode: "fullscreen" })
    })

    expect(document.body.querySelector("iframe")).toBe(iframe)
    await user.click(screen.getByRole("button", { name: "Close fullscreen MCP app" }))
    expect(document.body.querySelector("iframe")).toBe(iframe)
    expect(bridgeInstances).toHaveLength(1)
  })

  it("forwards app tool calls with artifact binding for backend same-server authorization", async () => {
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{
          server: "excalidraw",
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    const result = await bridgeInstances[0]?.oncalltool?.({ name: "custom_chart_tool", arguments: { chartId: "chart-1" } })

    expect(result).toEqual({ content: [{ type: "text", text: "saved" }] })
    expect(callMcpAppTool).toHaveBeenCalledWith({
      session_id: "session-1",
      tool_call_id: "tool-call-1",
      server: "excalidraw",
      tool: "custom_chart_tool",
      arguments: { chartId: "chart-1" },
    })
  })

  it("returns backend denials as failed tool results", async () => {
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{
          server: "excalidraw",
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    callMcpAppTool.mockImplementation(async () => {
      throw new Error("MCP tool 'delete_everything' is not available.")
    })
    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    const result = await bridgeInstances[0]?.oncalltool?.({ name: "delete_everything" })

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "MCP tool 'delete_everything' is not available." }],
    })
    expect(callMcpAppTool).toHaveBeenCalledWith({
      session_id: "session-1",
      tool_call_id: "tool-call-1",
      server: "excalidraw",
      tool: "delete_everything",
      arguments: {},
    })
  })

  it("fails closed when app tool arguments are not objects", async () => {
    render(
      <MCPAppResult
        sessionId="session-1"
        toolCallId="tool-call-1"
        mcpApp={{
          server: "excalidraw",
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await waitFor(() => expect(bridgeInstances[0]?.connect).toHaveBeenCalled())
    const result = await bridgeInstances[0]?.oncalltool?.({ name: "save_checkpoint", arguments: ["bad"] })

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "MCP app tool arguments must be a JSON object." }],
    })
    expect(callMcpAppTool).not.toHaveBeenCalled()
  })
})

describe("MCPAppResult — mobile edge-swipe exclusion", () => {
  it("does not mark the inline container swipe-ignored", () => {
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    const iframe = document.body.querySelector("iframe")
    expect(iframe?.closest("[data-swipe-ignore]")).toBeNull()
  })

  it("marks the container data-swipe-ignore once expanded to fullscreen", async () => {
    // Regression: the fullscreen MCP app view is a `fixed inset-0` overlay
    // that can reach the screen edges. Without data-swipe-ignore, the
    // outer useEdgeSwipe drawer controller would read an edge-zone touch
    // on it as an open/close gesture for the sidebar/actions drawer.
    const user = userEvent.setup()
    render(
      <MCPAppResult
        mcpApp={{
          tool: "create_view",
          resourceUri: "ui://excalidraw/mcp-app.html",
          html: "<html><body>mcp app</body></html>",
          mimeType: "text/html;profile=mcp-app",
        }}
      />,
    )

    await user.click(screen.getByRole("button", { name: /open create_view fullscreen/i }))

    const iframe = document.body.querySelector("iframe")
    expect(iframe?.closest("[data-swipe-ignore]")).not.toBeNull()
  })
})

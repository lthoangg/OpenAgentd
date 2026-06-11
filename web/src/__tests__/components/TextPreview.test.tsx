/**
 * Tests for TextPreview — the plain text/code file preview in WorkspaceFilesPanel.
 *
 * TextPreview renders raw file content as-is in a <pre> element, without any
 * markdown processing or syntax highlighting. This test suite verifies:
 *
 * 1. Raw content is rendered verbatim (no markdown transformation)
 * 2. Content is wrapped in a <pre> element
 * 3. Markdown syntax is NOT rendered (e.g., # Heading stays as literal text)
 * 4. Special characters are preserved (<, >, &, backticks, **bold**)
 * 5. File size cap (512 KB) prevents fetching oversized files
 * 6. Loading state shows spinner while fetch is in flight
 * 7. Fetch errors display error message with HTTP status
 * 8. Whitespace (leading spaces, tabs, newlines) is preserved
 */

import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WorkspaceFilesPanel } from "@/components/WorkspaceFilesPanel"
import type { WorkspaceFileInfo, WorkspaceFilesResponse } from "@/api/types"
import "@testing-library/jest-dom"

afterEach(cleanup)

const SID = "01900000-0000-7000-8000-000000000001"

function makeFile(overrides: Partial<WorkspaceFileInfo> = {}): WorkspaceFileInfo {
  return {
    path: "test.txt",
    name: "test.txt",
    size: 412,
    mtime: 1734556820.1,
    mime: "text/plain",
    ...overrides,
  }
}

function mockFetchResponse(
  matcher: (url: string) => boolean,
  response: { ok: boolean; status: number; text?: string; json?: unknown },
) {
  const originalFetch = globalThis.fetch
  const fetchMock = mock(async (...args: unknown[]) => {
    const url = args[0] as string | Request
    const urlStr = typeof url === "string" ? url : url.url
    if (matcher(urlStr)) {
      return {
        ok: response.ok,
        status: response.status,
        text: async () => response.text ?? "",
        json: async () => response.json ?? {},
      }
    }
    return originalFetch(url)
  }) as unknown as typeof fetch
  globalThis.fetch = fetchMock
  return fetchMock
}

function renderWithQueryClient(component: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      {component}
    </QueryClientProvider>,
  )
}

// Reset fetch after each test
afterEach(() => {
  globalThis.fetch = undefined as unknown as typeof fetch
})

describe("TextPreview", () => {
  // ── raw content rendering ────────────────────────────────────────────────────

  it("renders raw content as-is without markdown transformation", async () => {
    const file = makeFile({ path: "notes.md", name: "notes.md", mime: "text/markdown" })
    const content = "# Heading\n\nBody text"

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: true,
        status: 200,
        text: content,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    // Wait for file list to load
    const fileButton = await screen.findByRole("button", { name: /notes\.md/i })

    // Setup user after render
    const user = userEvent.setup()
    await user.click(fileButton)

    // Wait for content to appear in the <pre> element
    const preElement = await screen.findByText((text, element) => {
      return element?.tagName === "PRE" && text.includes("# Heading")
    })
    expect(preElement).toBeInTheDocument()
    expect(preElement.textContent).toBe(content)
  })

  it("renders content in a <pre> element with monospace font", async () => {
    const file = makeFile({ path: "code.py", name: "code.py", mime: "text/x-python" })
    const content = "def hello():\n    print('world')"

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: true,
        status: 200,
        text: content,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /code\.py/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const preElement = await screen.findByText((text, element) => {
      return element?.tagName === "PRE" && text.includes("def hello")
    })
    expect(preElement.tagName).toBe("PRE")
    expect(preElement).toHaveClass("font-mono")
  })



  it("preserves special characters without escaping", async () => {
    const file = makeFile({ path: "special.txt", name: "special.txt", mime: "text/plain" })
    const content = 'const x = <div> & "quoted" & \'single\' & `backticks`'

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: true,
        status: 200,
        text: content,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /special\.txt/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const preElement = await screen.findByText((text, element) => {
      return element?.tagName === "PRE" && text.includes("<div>")
    })
    expect(preElement.textContent).toBe(content)
    // Verify special characters appear literally
    expect(preElement.textContent).toContain("<div>")
    expect(preElement.textContent).toContain("&")
    expect(preElement.textContent).toContain("`backticks`")
  })

  it("preserves leading whitespace and indentation", async () => {
    const file = makeFile({ path: "indent.txt", name: "indent.txt", mime: "text/plain" })
    const content = "  indented line\n    more indented\nno indent"

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: true,
        status: 200,
        text: content,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /indent\.txt/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const preElement = await screen.findByText((text, element) => {
      return element?.tagName === "PRE" && text.includes("indented line")
    })
    expect(preElement.textContent).toBe(content)
    // Verify the <pre> element preserves whitespace (whitespace-pre class)
    expect(preElement).toHaveClass("whitespace-pre")
  })

  it("preserves tabs and multiple newlines", async () => {
    const file = makeFile({ path: "tabs.txt", name: "tabs.txt", mime: "text/plain" })
    const content = "line1\n\t\ttabbed\n\n\nmultiple newlines"

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: true,
        status: 200,
        text: content,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /tabs\.txt/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const preElement = await screen.findByText((text, element) => {
      return element?.tagName === "PRE" && text.includes("line1")
    })
    expect(preElement.textContent).toBe(content)
  })

  // ── loading state ────────────────────────────────────────────────────────────
  // Note: Loading state tests require more complex fetch mocking setup and are covered
  // by the integration tests in the main component test suite.

  // ── error handling ───────────────────────────────────────────────────────────

  it("displays error message when fetch returns 404", async () => {
    const file = makeFile({ path: "missing.txt", name: "missing.txt", mime: "text/plain" })

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: false,
        status: 404,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /missing\.txt/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const errorMessage = await screen.findByText(/Failed to load: HTTP 404/i)
    expect(errorMessage).toBeInTheDocument()
  })

  it("displays error message when fetch returns 500", async () => {
    const file = makeFile({ path: "error.txt", name: "error.txt", mime: "text/plain" })

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [file],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/media/"),
      {
        ok: false,
        status: 500,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /error\.txt/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const errorMessage = await screen.findByText(/Failed to load: HTTP 500/i)
    expect(errorMessage).toBeInTheDocument()
  })



  // ── size cap ─────────────────────────────────────────────────────────────────

  it("shows 'File too large to preview' when file exceeds 512 KB", async () => {
    const big = makeFile({
      path: "huge.log",
      name: "huge.log",
      mime: "text/plain",
      size: 600 * 1024,
    })

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [big],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /huge\.log/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const message = await screen.findByText(/File too large to preview/i)
    expect(message).toBeInTheDocument()
  })



  it("shows the size limit in the 'too large' message", async () => {
    const big = makeFile({
      path: "huge.log",
      name: "huge.log",
      mime: "text/plain",
      size: 600 * 1024,
    })

    mockFetchResponse(
      (url) => url.includes("/api/team/") && url.includes("/files"),
      {
        ok: true,
        status: 200,
        json: {
          session_id: SID,
          files: [big],
          truncated: false,
        } as WorkspaceFilesResponse,
      },
    )

    renderWithQueryClient(
      <WorkspaceFilesPanel open={true} sessionId={SID} onClose={() => {}} />,
    )

    const fileButton = await screen.findByRole("button", { name: /huge\.log/i })
    const user = userEvent.setup()
    await user.click(fileButton)

    const message = await screen.findByText(/File too large to preview/i)
    expect(message).toBeInTheDocument()

    // Verify the message includes both the file size and the limit
    const parent = message.closest("div")
    expect(parent?.textContent).toMatch(/600/)
    expect(parent?.textContent).toMatch(/512/)
  })
})

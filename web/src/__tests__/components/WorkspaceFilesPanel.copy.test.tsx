/**
 * Tests for CopyContentsButton — the header copy-to-clipboard button in the
 * workspace files preview pane.  Replaced the previous "Open in new tab"
 * external-link button.
 */

import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CopyContentsButton } from "@/components/WorkspaceFilesPanel"
import type { WorkspaceFileInfo } from "@/api/types"

afterEach(cleanup)

const SID = "01900000-0000-7000-8000-000000000001"

function makeFile(overrides: Partial<WorkspaceFileInfo> = {}): WorkspaceFileInfo {
  return {
    path: "notes.md",
    name: "notes.md",
    size: 412,
    mtime: 1734556820.1,
    mime: "text/markdown",
    ...overrides,
  }
}

function mockClipboard() {
  const writeText = mock(async () => {})
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
  return writeText
}

function mockFetchOk(body: string) {
  const fetchMock = mock(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch
  globalThis.fetch = fetchMock
  return fetchMock as unknown as ReturnType<typeof mock>
}

function mockFetchFail(status = 500) {
  const fetchMock = mock(async () => ({
    ok: false,
    status,
    text: async () => "",
  })) as unknown as typeof fetch
  globalThis.fetch = fetchMock
  return fetchMock as unknown as ReturnType<typeof mock>
}

describe("CopyContentsButton", () => {
  // ── basic rendering ──────────────────────────────────────────────────────────

  it("renders an enabled button with the copy tooltip by default", () => {
    mockClipboard()
    render(<CopyContentsButton sessionId={SID} file={makeFile()} />)
    const btn = screen.getByRole("button", { name: /copy file contents/i })
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it("uses the copy tooltip on title and aria-label", () => {
    mockClipboard()
    render(<CopyContentsButton sessionId={SID} file={makeFile()} />)
    const btn = screen.getByRole("button", { name: /copy file contents/i })
    expect(btn.getAttribute("title")).toBe("Copy file contents")
    expect(btn.getAttribute("aria-label")).toBe("Copy file contents")
  })

  // ── happy path ───────────────────────────────────────────────────────────────

  it("fetches the file via the media proxy and writes contents to the clipboard", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    const fetchMock = mockFetchOk("# Heading\n\nbody text")

    render(<CopyContentsButton sessionId={SID} file={makeFile({ path: "notes.md" })} />)
    await user.click(screen.getByRole("button", { name: /copy file contents/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText).toHaveBeenCalledWith("# Heading\n\nbody text")

    // Verifies the URL hits the workspace media proxy for the right session/path.
    expect(fetchMock).toHaveBeenCalledOnce()
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as string
    expect(url).toContain(`/api/team/${SID}/media/notes.md`)
  })

  it("URL-encodes nested file paths when fetching", async () => {
    const user = userEvent.setup()
    mockClipboard()
    const fetchMock = mockFetchOk("plot data")

    render(
      <CopyContentsButton
        sessionId={SID}
        file={makeFile({ path: "output/charts/q3.csv", name: "q3.csv", mime: "text/csv" })}
      />,
    )
    await user.click(screen.getByRole("button", { name: /copy file contents/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as string
    // Slashes must survive (path segments), not be encoded as %2F.
    expect(url).toContain(`/api/team/${SID}/media/output/charts/q3.csv`)
  })

  it("flips to the success tooltip after a successful copy", async () => {
    const user = userEvent.setup()
    mockClipboard()
    mockFetchOk("hello")

    render(<CopyContentsButton sessionId={SID} file={makeFile()} />)
    await user.click(screen.getByRole("button", { name: /copy file contents/i }))

    // After the async fetch + clipboard write resolves, the button label flips.
    const copied = await screen.findByRole("button", { name: /copied!/i })
    expect(copied).toBeTruthy()
  })

  // ── size cap ────────────────────────────────────────────────────────────────

  it("disables the button and explains why when the file exceeds 512 KB", () => {
    mockClipboard()
    const big = makeFile({ size: 600 * 1024 }) // > 512 KB cap
    render(<CopyContentsButton sessionId={SID} file={big} />)

    const btn = screen.getByRole("button", { name: /file too large to copy/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.getAttribute("title")).toMatch(/file too large to copy/i)
    expect(btn.getAttribute("title")).toMatch(/512/)
  })

  it("does not call fetch or clipboard when oversized", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    const fetchMock = mockFetchOk("ignored")
    const big = makeFile({ size: 1024 * 1024 })

    render(<CopyContentsButton sessionId={SID} file={big} />)
    await user.click(screen.getByRole("button", { name: /file too large to copy/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  // ── failure modes ───────────────────────────────────────────────────────────

  it("does not write to clipboard when the media proxy returns non-2xx", async () => {
    const user = userEvent.setup()
    const writeText = mockClipboard()
    mockFetchFail(404)

    render(<CopyContentsButton sessionId={SID} file={makeFile()} />)
    await user.click(screen.getByRole("button", { name: /copy file contents/i }))

    // Give the failed fetch + catch a tick to settle.
    await new Promise((r) => setTimeout(r, 10))
    expect(writeText).not.toHaveBeenCalled()

    // Button remains in its default state (no "Copied!" flip).
    expect(screen.queryByRole("button", { name: /copied!/i })).toBeNull()
    expect(screen.getByRole("button", { name: /copy file contents/i })).toBeTruthy()
  })

  it("swallows clipboard.writeText rejections without throwing", async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mock(async () => { throw new Error("denied") }) },
      configurable: true,
    })
    mockFetchOk("hello")

    render(<CopyContentsButton sessionId={SID} file={makeFile()} />)
    await user.click(screen.getByRole("button", { name: /copy file contents/i }))

    await new Promise((r) => setTimeout(r, 10))
    // Did not flip to success state — the rejection was caught.
    expect(screen.queryByRole("button", { name: /copied!/i })).toBeNull()
  })
})

import { describe, it, expect, afterEach, mock } from "bun:test"

let isTauriMock = false
mock.module("@/hooks/use-platform", () => ({
  getPlatform: () => ({ isTauri: isTauriMock })
}))
mock.module("@/stores/useToastStore", () => ({
  useToastStore: { getState: () => ({ push: () => {} }) },
}))

import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { FileLightbox, type FileLightboxItem } from "@/components/FileLightbox"

type InvokeRequest = { request: Record<string, unknown> }

afterEach(cleanup)

describe("FileLightbox", () => {
  const items: FileLightboxItem[] = [
    { type: "image", src: "image1.png", name: "Image 1" },
    { type: "image", src: "image2.png", name: "Image 2" },
    { type: "video", src: "video1.mp4", name: "Video 1" },
  ]

  it("does not render when isOpen is false", () => {
    render(<FileLightbox items={items} index={0} isOpen={false} onClose={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("renders when isOpen is true", () => {
    render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => {}} />)
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Image 1")).toBeTruthy()
  })

  it("triggers onClose when clicking close button", () => {
    let closed = false
    render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => { closed = true }} />)
    fireEvent.click(screen.getByRole("button", { name: /close preview/i }))
    expect(closed).toBe(true)
  })

  it("triggers onClose when clicking backdrop", () => {
    let closed = false
    render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => { closed = true }} />)
    fireEvent.click(screen.getByRole("dialog"))
    expect(closed).toBe(true)
  })

  it("does not trigger onClose when clicking the image itself", () => {
    let closed = false
    render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => { closed = true }} />)
    fireEvent.click(screen.getByRole("img", { name: /image 1/i }))
    expect(closed).toBe(false)
  })

  it("triggers onClose when pressing escape", () => {
    let closed = false
    render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => { closed = true }} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(closed).toBe(true)
  })

  it("updates the active preview when navigating via index prop", () => {
    const { rerender } = render(<FileLightbox items={items} index={0} isOpen={true} onClose={() => {}} />)
    expect(screen.getByRole("img", { name: /image 1/i })).toBeTruthy()
    rerender(<FileLightbox items={items} index={1} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByRole("img", { name: /image 1/i })).toBeNull()
    expect(screen.getByRole("img", { name: /image 2/i })).toBeTruthy()
  })

  it("renders text content preview", () => {
    const textItems: FileLightboxItem[] = [
      { type: "text", src: "test.txt", name: "test.txt", textContent: "Hello world text content" }
    ]
    render(<FileLightbox items={textItems} index={0} isOpen={true} onClose={() => {}} />)
    expect(screen.getByText("Hello world text content")).toBeTruthy()
  })

  it("renders pdf open-in-new-tab link", () => {
    render(<FileLightbox items={[{ type: "pdf", src: "doc.pdf", name: "doc.pdf" }]} index={0} isOpen={true} onClose={() => {}} />)
    expect(screen.getByText("Open in new tab")).toBeTruthy()
  })

  it("renders generic file card with filename and open link", () => {
    render(<FileLightbox items={[{ type: "file", src: "/api/files/archive.zip", name: "archive.zip" }]} index={0} isOpen={true} onClose={() => {}} />)
    expect(screen.getAllByText("archive.zip").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Open in new tab")).toBeTruthy()
  })

  // ── Download: non-Tauri → anchor ─────────────────────────────────────────

  it("triggers anchor download outside Tauri", async () => {
    isTauriMock = false
    let capturedDownload = ""
    const origCreate = document.createElement.bind(document)
    document.createElement = (tag: string) => {
      const el = origCreate(tag)
      if (tag === "a") {
        Object.defineProperty(el, "download", {
          set(v: string) { capturedDownload = v },
          get() { return capturedDownload },
        })
        el.click = () => {}
      }
      return el
    }
    render(<FileLightbox items={[{ type: "text", src: "/api/test.txt", name: "test.txt", textContent: "hi" }]} index={0} isOpen={true} onClose={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /download file/i }))
    await new Promise((r) => setTimeout(r, 50))
    expect(capturedDownload).toBe("test.txt")
    document.createElement = origCreate
  })

  // ── Download: Tauri + http URL → passes url directly ────────────────────

  it("invokes save_workspace_file with url for http src in Tauri", async () => {
    isTauriMock = true
    let captured: unknown = null
    mock.module("@tauri-apps/api/core", () => ({
      invoke: async (_cmd: string, args: InvokeRequest) => { captured = args; return true }
    }))
    render(<FileLightbox items={[{ type: "text", src: "/api/report.txt", name: "report.txt", textContent: "d" }]} index={0} isOpen={true} onClose={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /download file/i }))
    await new Promise((r) => setTimeout(r, 80))
    const r1 = (captured as unknown as InvokeRequest).request
    expect(String(r1.url)).toContain("report.txt")
    expect(r1.base64).toBeUndefined()
    expect(r1.filename).toBe("report.txt")
    isTauriMock = false
  })

  // ── Download: Tauri + blob URL → reads to base64 in JS ──────────────────

  it("invokes save_workspace_file with base64 for blob: src in Tauri", async () => {
    isTauriMock = true
    let captured: unknown = null
    mock.module("@tauri-apps/api/core", () => ({
      invoke: async (_cmd: string, args: InvokeRequest) => { captured = args; return true }
    }))
    const origFetch = window.fetch
    window.fetch = async () => ({ ok: true, blob: async () => new Blob(["Hello Tauri"], { type: "text/plain" }) } as Response)
    render(<FileLightbox items={[{ type: "text", src: "blob:http://localhost/abc", name: "upload.txt", textContent: "d" }]} index={0} isOpen={true} onClose={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /download file/i }))
    await new Promise((r) => setTimeout(r, 80))
    const r2 = (captured as unknown as InvokeRequest).request
    expect(r2.base64).toBe("SGVsbG8gVGF1cmk=")
    expect(r2.url).toBeUndefined()
    expect(r2.filename).toBe("upload.txt")
    window.fetch = origFetch
    isTauriMock = false
  })

  // ── Scroll/swipe isolation ───────────────────────────────────────────────

  it("stops vertical touchmove propagation in text preview", () => {
    render(<FileLightbox items={[{ type: "text", src: "t.txt", name: "t.txt", textContent: "Hi" }]} index={0} isOpen={true} onClose={() => {}} />)
    const pre = document.querySelector("pre")
    if (!pre) return
    let propagated = false
    pre.parentElement?.parentElement?.addEventListener("touchmove", () => { propagated = true })
    pre.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [{ clientX: 100, clientY: 100 } as Touch] }))
    pre.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [{ clientX: 100, clientY: 200 } as Touch] }))
    expect(propagated).toBe(false)
  })

  it("prevents default on horizontal touchmove in text preview", () => {
    render(<FileLightbox items={[{ type: "text", src: "t.txt", name: "t.txt", textContent: "Hi" }]} index={0} isOpen={true} onClose={() => {}} />)
    const pre = document.querySelector("pre")
    if (!pre) return
    pre.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [{ clientX: 100, clientY: 100 } as Touch] }))
    const move = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [{ clientX: 200, clientY: 100 } as Touch] })
    let defaultPrevented = false
    move.preventDefault = () => { defaultPrevented = true }
    pre.dispatchEvent(move)
    expect(defaultPrevented).toBe(true)
  })
})

import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ImageLightbox } from "@/components/ImageLightbox"

afterEach(cleanup)

describe("ImageLightbox", () => {
  // ── Rendering & Visibility ───────────────────────────────────────────────────

  it("returns null when isOpen is false", () => {
    const { container } = render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={false} onClose={mock(() => {})} />
    )
    const dialog = container.querySelector("[role='dialog']")
    expect(dialog).toBeNull()
  })

  it("renders dialog portal when isOpen is true", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )
    const dialog = document.body.querySelector("[role='dialog']")
    expect(dialog).toBeTruthy()
  })

  it("renders image with correct src and alt", () => {
    render(
      <ImageLightbox src="https://example.com/photo.jpg" alt="Test photo" isOpen={true} onClose={mock(() => {})} />
    )
    const img = screen.getByRole("img", { name: "Test photo" })
    expect(img).toBeTruthy()
    expect((img as HTMLImageElement).src).toContain("example.com/photo.jpg")
  })

  it("renders alt text below image when alt is provided", () => {
    render(
      <ImageLightbox src="https://example.com/photo.jpg" alt="My caption" isOpen={true} onClose={mock(() => {})} />
    )
    expect(screen.getByText("My caption")).toBeTruthy()
  })

  it("does not render alt text when alt is empty", () => {
    render(
      <ImageLightbox src="https://example.com/photo.jpg" alt="" isOpen={true} onClose={mock(() => {})} />
    )
    const captions = document.querySelectorAll("p")
    expect(captions.length).toBe(0)
  })

  // ── Close Behavior ───────────────────────────────────────────────────────────

  it("closes when close button is clicked", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    const { rerender } = render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    const closeBtn = screen.getByLabelText("Close lightbox")
    await user.click(closeBtn)

    expect(onClose).toHaveBeenCalledTimes(1)

    // Re-render with isOpen=false to verify it closes
    rerender(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={false} onClose={onClose} />
    )
    expect(document.body.querySelector("[role='dialog']")).toBeNull()
  })

  it("closes when backdrop is clicked", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    const backdrop = document.body.querySelector("[role='dialog']") as HTMLElement
    await user.click(backdrop)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not close when image is clicked (stopPropagation)", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    const img = screen.getByRole("img", { name: "Test" })
    await user.click(img)

    expect(onClose).not.toHaveBeenCalled()
  })

  it("closes on swipe-down touch gesture", () => {
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    const img = screen.getByRole("img", { name: "Test" }).parentElement as HTMLElement
    fireEvent.touchStart(img, { touches: [{ clientY: 10 }] })
    fireEvent.touchMove(img, { touches: [{ clientY: 120 }] })
    fireEvent.touchEnd(img)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("zooms image on double tap/click", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const img = screen.getByRole("img", { name: "Test" }) as HTMLImageElement
    fireEvent.doubleClick(img.parentElement as HTMLElement)

    expect(img.style.transform).toContain("scale(2)")
  })

  it("pinch-zooms image on two-finger touch move", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const img = screen.getByRole("img", { name: "Test" }) as HTMLImageElement
    const target = img.parentElement as HTMLElement
    fireEvent.touchStart(target, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 50, clientY: 0 }] })
    fireEvent.touchMove(target, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] })

    expect(img.style.transform).toContain("scale(2)")
  })

  it("closes when Escape key is pressed", async () => {
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    fireEvent.keyDown(document, { key: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not close when non-Escape key is pressed", async () => {
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={onClose} />
    )

    fireEvent.keyDown(document, { key: "Enter" })

    expect(onClose).not.toHaveBeenCalled()
  })

  // ── Body Scroll Lock ─────────────────────────────────────────────────────────

  it("locks body scroll when lightbox opens", () => {
    document.body.style.overflow = "auto"

    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    expect(document.body.style.overflow).toBe("hidden")

    // Cleanup will restore it
  })

  it("restores body scroll when lightbox closes", () => {
    document.body.style.overflow = "auto"

    const { rerender } = render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    expect(document.body.style.overflow).toBe("hidden")

    rerender(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={false} onClose={mock(() => {})} />
    )

    expect(document.body.style.overflow).toBe("auto")
  })

  it("restores body scroll on unmount", () => {
    document.body.style.overflow = "auto"

    const { unmount } = render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    expect(document.body.style.overflow).toBe("hidden")

    unmount()

    expect(document.body.style.overflow).toBe("auto")
  })

  // ── Download Button: Tooltips ────────────────────────────────────────────────

  it("renders download button with tooltip", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    expect(downloadBtn).toBeTruthy()

    const tooltip = document.querySelector("[role='tooltip']")
    expect(tooltip).toBeTruthy()
    expect(tooltip?.textContent).toBe("Download")
  })

  it("renders close button with tooltip", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const closeBtn = screen.getByLabelText("Close lightbox")
    expect(closeBtn).toBeTruthy()

    const tooltips = document.querySelectorAll("[role='tooltip']")
    const closeTooltip = Array.from(tooltips).find((t) => t.textContent === "Close (Esc)")
    expect(closeTooltip).toBeTruthy()
  })

  // ── Download Button: Fetch Success Path ──────────────────────────────────────

  it("downloads image via fetch + blob URL on success", async () => {
    const user = userEvent.setup()

    // Mock fetch to return a blob
    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    const mockFetch = mock(async () => ({
      blob: async () => mockBlob,
    }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const mockCreateObjectURL = mock(() => "blob:http://localhost/fake-uuid")
    const mockRevokeObjectURL = mock(() => {})
    globalThis.URL.createObjectURL = mockCreateObjectURL as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL as unknown as typeof URL.revokeObjectURL

    // Mock HTMLAnchorElement.prototype.click
    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    render(
      <ImageLightbox src="https://example.com/image.png" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    // Verify fetch was called with the image src
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/image.png")

    // Verify blob URL was created
    expect(mockCreateObjectURL).toHaveBeenCalledWith(mockBlob)

    // Verify anchor element was clicked
    expect(mockClick).toHaveBeenCalled()

    // Verify blob URL was revoked
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/fake-uuid")

    // Restore
    HTMLAnchorElement.prototype.click = originalClick
  })

  it("sets correct download filename on anchor element (fetch path)", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    const mockFetch = mock(async () => ({
      blob: async () => mockBlob,
    }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const mockCreateObjectURL = mock(() => "blob:http://localhost/fake-uuid")
    const mockRevokeObjectURL = mock(() => {})
    globalThis.URL.createObjectURL = mockCreateObjectURL as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL as unknown as typeof URL.revokeObjectURL

    // Spy on createElement to capture the anchor element
    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    // Mock click to prevent actual navigation
    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    // Set window.location.origin for URL parsing
    Object.defineProperty(window, "location", {
      value: { origin: "http://localhost" },
      writable: true,
    })

    render(
      <ImageLightbox src="https://example.com/photo.png" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toBe("photo.png")

    // Restore
    document.createElement = originalCreateElement
    HTMLAnchorElement.prototype.click = originalClick
  })

  // ── Download Button: Fetch Failure Fallback ──────────────────────────────────

  it("falls back to direct link when fetch fails", async () => {
    const user = userEvent.setup()

    // Mock fetch to throw
    globalThis.fetch = mock(async () => {
      throw new Error("Network error")
    }) as unknown as typeof fetch

    // Spy on createElement to capture the anchor element
    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    // Mock click to prevent actual navigation
    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    render(
      <ImageLightbox src="https://example.com/image.png" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    // Verify fallback anchor was created with direct src
    const anchor = capturedAnchor as HTMLAnchorElement | null
    expect(anchor?.href).toContain("example.com/image.png")
    expect(anchor?.target).toBe("_blank")
    expect(anchor?.rel).toBe("noopener noreferrer")

    // Restore
    document.createElement = originalCreateElement
    HTMLAnchorElement.prototype.click = originalClick
  })

  // ── Filename Derivation: Regular URLs ────────────────────────────────────────

  it("derives filename from URL with extension", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    // Mock click to prevent actual navigation
    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    // Set window.location.origin for URL parsing
    Object.defineProperty(window, "location", {
      value: { origin: "http://localhost" },
      writable: true,
    })

    render(
      <ImageLightbox src="https://example.com/path/to/my-photo.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toBe("my-photo.jpg")

    document.createElement = originalCreateElement
    HTMLAnchorElement.prototype.click = originalClick
  })

  it("derives filename from URL without extension (adds .png)", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    // Mock click to prevent actual navigation
    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    // Set window.location.origin for URL parsing
    Object.defineProperty(window, "location", {
      value: { origin: "http://localhost" },
      writable: true,
    })

    render(
      <ImageLightbox src="https://example.com/path/to/image" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toBe("image.png")

    document.createElement = originalCreateElement
    HTMLAnchorElement.prototype.click = originalClick
  })

  // ── Filename Derivation: data: URIs ──────────────────────────────────────────

  it("derives filename from data: URI with mime type and alt text", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    render(
      <ImageLightbox src={dataUri} alt="My Screenshot" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toBe("My_Screenshot.png")

    document.createElement = originalCreateElement
  })

  it("derives filename from data: URI without alt (uses timestamp)", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/jpeg" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    const dataUri = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA=="
    render(
      <ImageLightbox src={dataUri} alt="" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    // Should be image-<timestamp>.jpeg
    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toMatch(/^image-\d+\.jpeg$/)

    document.createElement = originalCreateElement
  })

  it("sanitizes alt text in filename (replaces non-word chars with underscore)", async () => {
    const user = userEvent.setup()

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const originalCreateElement = document.createElement.bind(document)
    let capturedAnchor: HTMLAnchorElement | null = null
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = originalCreateElement(tagName, options)
      if (tagName === "a") {
        capturedAnchor = el as HTMLAnchorElement
      }
      return el
    } as unknown as typeof document.createElement

    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    render(
      <ImageLightbox src={dataUri} alt="My Photo (2024) - Test!" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    // Regex /[^\w.-]+/g keeps word chars, dots, and hyphens; replaces everything else with _
    // So "My Photo (2024) - Test!" becomes "My_Photo_2024_-_Test_"
    expect((capturedAnchor as HTMLAnchorElement | null)?.download).toBe("My_Photo_2024_-_Test_.png")

    document.createElement = originalCreateElement
  })

  // ── Download Button: stopPropagation ─────────────────────────────────────────

  it("does not close lightbox when download button is clicked (stopPropagation)", async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})

    const mockBlob = new Blob(["fake image data"], { type: "image/png" })
    globalThis.fetch = mock(async () => ({
      blob: async () => mockBlob,
    })) as unknown as typeof fetch

    globalThis.URL.createObjectURL = mock(() => "blob:http://localhost/fake-uuid") as unknown as typeof URL.createObjectURL
    globalThis.URL.revokeObjectURL = mock(() => {}) as unknown as typeof URL.revokeObjectURL

    const mockClick = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = mockClick as unknown as typeof HTMLAnchorElement.prototype.click

    render(
      <ImageLightbox src="https://example.com/image.png" alt="Test" isOpen={true} onClose={onClose} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    // onClose should NOT be called
    expect(onClose).not.toHaveBeenCalled()

    HTMLAnchorElement.prototype.click = originalClick
  })

  // ── Accessibility ───────────────────────────────────────────────────────────

  it("has proper ARIA attributes on dialog", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const dialog = document.body.querySelector("[role='dialog']") as HTMLElement
    expect(dialog?.getAttribute("aria-modal")).toBe("true")
    expect(dialog?.getAttribute("aria-label")).toBe("Image lightbox")
  })

  it("buttons have proper aria-label attributes", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    const closeBtn = screen.getByLabelText("Close lightbox")

    expect(downloadBtn).toBeTruthy()
    expect(closeBtn).toBeTruthy()
  })

  it("positions lightbox actions below the iOS safe-area notch", () => {
    render(
      <ImageLightbox src="https://example.com/image.jpg" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    const actionBar = downloadBtn.parentElement?.parentElement

    expect(actionBar?.className).toContain("[[data-mobile-shell='ios']_&]:top-[max(4rem,calc(env(safe-area-inset-top)+1rem))]")
  })
})

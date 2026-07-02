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
    const img = screen.getByRole("img", { name: "Test photo" }) as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.src).toContain("example.com/photo.jpg")
    expect(img.className).toContain("object-contain")
    expect(img.className).toContain("h-auto")
    expect(img.className).toContain("w-auto")
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

  it("downloads image via tauriDownload on success", async () => {
    const user = userEvent.setup()
    const download = mock(async () => {})
    mock.module("@/lib/tauri-download", () => ({ tauriDownload: download }))

    const { ImageLightbox: FreshImageLightbox } = await import("@/components/ImageLightbox")

    render(
      <FreshImageLightbox src="https://example.com/image.png" alt="Test" isOpen={true} onClose={mock(() => {})} />
    )

    const downloadBtn = screen.getByLabelText("Download image")
    await user.click(downloadBtn)

    expect(download).toHaveBeenCalledWith("https://example.com/image.png", "image.png")
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

  // ── Gallery navigation ───────────────────────────────────────────────────────

  const GALLERY = [
    { src: "https://example.com/a.jpg", alt: "Image A" },
    { src: "https://example.com/b.jpg", alt: "Image B" },
    { src: "https://example.com/c.jpg", alt: "Image C" },
  ]

  it("shows prev/next controls and a counter only for galleries", () => {
    const { rerender } = render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} />
    )
    // Single image: no nav controls.
    expect(screen.queryByLabelText("Next image")).toBeNull()

    rerender(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} images={GALLERY} index={0} />
    )
    expect(screen.getByLabelText("Next image")).toBeTruthy()
    expect(screen.getByLabelText("Previous image")).toBeTruthy()
    expect(screen.getByText("1 / 3")).toBeTruthy()
  })

  it("advances to the next image via the chevron", () => {
    render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} images={GALLERY} index={0} />
    )
    fireEvent.click(screen.getByLabelText("Next image"))
    expect(screen.getByText("2 / 3")).toBeTruthy()
    expect((screen.getByRole("img") as HTMLImageElement).src).toContain("b.jpg")
  })

  it("wraps around when navigating past the ends", () => {
    render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} images={GALLERY} index={0} />
    )
    // Prev from first → wraps to last.
    fireEvent.click(screen.getByLabelText("Previous image"))
    expect(screen.getByText("3 / 3")).toBeTruthy()
  })

  it("navigates with arrow keys", () => {
    render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} images={GALLERY} index={0} />
    )
    fireEvent.keyDown(document, { key: "ArrowRight" })
    expect(screen.getByText("2 / 3")).toBeTruthy()
    fireEvent.keyDown(document, { key: "ArrowLeft" })
    expect(screen.getByText("1 / 3")).toBeTruthy()
  })

  it("advances on a horizontal swipe-left gesture", () => {
    render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={mock(() => {})} images={GALLERY} index={0} />
    )
    const target = screen.getByRole("img").parentElement as HTMLElement
    fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 102 }] })
    fireEvent.touchEnd(target)
    expect(screen.getByText("2 / 3")).toBeTruthy()
  })

  it("does not close on a horizontal swipe within a gallery", () => {
    const onClose = mock(() => {})
    render(
      <ImageLightbox src="https://example.com/a.jpg" alt="Image A" isOpen onClose={onClose} images={GALLERY} index={0} />
    )
    const target = screen.getByRole("img").parentElement as HTMLElement
    fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 105 }] })
    fireEvent.touchEnd(target)
    expect(onClose).not.toHaveBeenCalled()
  })
})

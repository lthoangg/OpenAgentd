import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ImageAttachment } from "@/components/ImageAttachment"

afterEach(cleanup)

describe("ImageAttachment", () => {
  // ── basic rendering ──────────────────────────────────────────────────────────

  it("renders image with correct src and alt", () => {
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="A test photo" />)
    const img = screen.getByRole("img", { name: "A test photo" })
    expect(img).toBeTruthy()
    expect((img as HTMLImageElement).src).toBe("https://example.com/photo.jpg")
  })

  it("uses default alt text when alt is not provided", () => {
    render(<ImageAttachment src="https://example.com/photo.jpg" />)
    const img = screen.getByRole("img", { name: "Image" })
    expect(img).toBeTruthy()
  })

  // ── lightbox ─────────────────────────────────────────────────────────────────

  it("clicking image opens lightbox dialog in document.body", async () => {
    const user = userEvent.setup()
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Lightbox test" />)

    const img = screen.getByRole("img", { name: "Lightbox test" })
    await user.click(img)

    // Lightbox is rendered via createPortal into document.body
    const dialog = document.body.querySelector("[role='dialog']")
    expect(dialog).toBeTruthy()
  })

  it("lightbox shows close button after opening", async () => {
    const user = userEvent.setup()
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Close test" />)

    const img = screen.getByRole("img", { name: "Close test" })
    await user.click(img)

    const closeBtn = screen.getByLabelText("Close lightbox")
    expect(closeBtn).toBeTruthy()
  })

  it("clicking close button dismisses the lightbox", async () => {
    const user = userEvent.setup()
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Dismiss test" />)

    const img = screen.getByRole("img", { name: "Dismiss test" })
    await user.click(img)

    // Lightbox is open
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()

    const closeBtn = screen.getByLabelText("Close lightbox")
    await user.click(closeBtn)

    // Lightbox is gone
    expect(document.body.querySelector("[role='dialog']")).toBeNull()
  })

  it("lightbox is not present before image is clicked", () => {
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="No lightbox yet" />)
    const dialog = document.body.querySelector("[role='dialog']")
    expect(dialog).toBeNull()
  })

  // ── remove button ─────────────────────────────────────────────────────────────

  it("remove button is not rendered when removable is false", () => {
    render(
      <ImageAttachment
        src="https://example.com/photo.jpg"
        alt="No remove"
        removable={false}
        onRemove={mock(() => {})}
      />
    )
    const removeBtn = screen.queryByLabelText("Remove image")
    expect(removeBtn).toBeNull()
  })

  it("remove button is not rendered when removable is true but onRemove is absent", () => {
    render(
      <ImageAttachment
        src="https://example.com/photo.jpg"
        alt="No callback"
        removable={true}
      />
    )
    const removeBtn = screen.queryByLabelText("Remove image")
    expect(removeBtn).toBeNull()
  })

  it("remove button is present in DOM when removable=true and onRemove provided", () => {
    render(
      <ImageAttachment
        src="https://example.com/photo.jpg"
        alt="With remove"
        removable={true}
        onRemove={mock(() => {})}
      />
    )
    const removeBtn = screen.getByLabelText("Remove image")
    expect(removeBtn).toBeTruthy()
  })

  it("clicking remove button calls onRemove callback", async () => {
    const user = userEvent.setup()
    const onRemove = mock(() => {})
    render(
      <ImageAttachment
        src="https://example.com/photo.jpg"
        alt="Remove callback"
        removable={true}
        onRemove={onRemove}
      />
    )

    const removeBtn = screen.getByLabelText("Remove image")
    await user.click(removeBtn)

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it("clicking remove button does not open the lightbox", async () => {
    const user = userEvent.setup()
    const onRemove = mock(() => {})
    render(
      <ImageAttachment
        src="https://example.com/photo.jpg"
        alt="Remove no lightbox"
        removable={true}
        onRemove={onRemove}
      />
    )

    const removeBtn = screen.getByLabelText("Remove image")
    await user.click(removeBtn)

    // Lightbox should NOT open when remove is clicked (stopPropagation)
    const dialog = document.body.querySelector("[role='dialog']")
    expect(dialog).toBeNull()
  })

  // ── error state ───────────────────────────────────────────────────────────────

  it("shows error message when image fails to load", () => {
    render(<ImageAttachment src="https://example.com/broken.jpg" alt="Broken image" />)

    const img = screen.getByRole("img", { name: "Broken image" })
    // Trigger the onError handler
    fireEvent.error(img)

    // Image should be replaced with error state
    expect(screen.getByText("Failed to load image")).toBeTruthy()
    // Original img element should no longer be in the DOM
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("does not show error state before image fails", () => {
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Good image" />)
    const errorText = screen.queryByText("Failed to load image")
    expect(errorText).toBeNull()
  })

  // ── Escape key handler (lines 17-19) ─────────────────────────────────────────

  it("pressing Escape while lightbox is open closes the lightbox", async () => {
    const user = userEvent.setup()
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Escape test" />)

    // Open the lightbox
    const img = screen.getByRole("img", { name: "Escape test" })
    await user.click(img)

    // Verify lightbox is open
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()

    // Dispatch Escape keydown on document
    fireEvent.keyDown(document, { key: 'Escape' })

    // Lightbox should be closed
    expect(document.body.querySelector("[role='dialog']")).toBeNull()
  })

  it("pressing a non-Escape key while lightbox is open does NOT close the lightbox", async () => {
    const user = userEvent.setup()
    render(<ImageAttachment src="https://example.com/photo.jpg" alt="Non-escape test" />)

    // Open the lightbox
    const img = screen.getByRole("img", { name: "Non-escape test" })
    await user.click(img)

    // Verify lightbox is open
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()

    // Dispatch a non-Escape key
    fireEvent.keyDown(document, { key: 'Enter' })

    // Lightbox should still be open
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()
  })
})

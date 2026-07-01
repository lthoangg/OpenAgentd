import { describe, it, expect, afterEach, mock, spyOn } from "bun:test"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FileCard } from "@/components/FileCard"

afterEach(cleanup)

describe("FileCard", () => {
  // ── basic rendering ──────────────────────────────────────────────────────────

  it("renders the filename", () => {
    render(<FileCard name="report.pdf" />)
    expect(screen.getByText("report.pdf")).toBeTruthy()
  })

  it("uses default name 'File' when name is not provided", () => {
    render(<FileCard />)
    expect(screen.getByText("File")).toBeTruthy()
  })

  it("truncates long filenames to ~20 chars with ellipsis", () => {
    render(<FileCard name="this-is-a-very-long-filename-that-exceeds-limit.txt" />)
    // Component truncates at 17 chars + "…" (substring(0, 17))
    expect(screen.getByText("this-is-a-very-lo…")).toBeTruthy()
  })

  it("does not truncate filenames at or under 20 chars", () => {
    render(<FileCard name="short-name.txt" />)
    expect(screen.getByText("short-name.txt")).toBeTruthy()
  })

  // ── remove button ─────────────────────────────────────────────────────────────

  it("remove button is not rendered when removable is false", () => {
    render(
      <FileCard
        name="file.txt"
        removable={false}
        onRemove={mock(() => {})}
      />
    )
    const removeBtn = screen.queryByLabelText("Remove file")
    expect(removeBtn).toBeNull()
  })

  it("remove button is not rendered when removable is true but onRemove is absent", () => {
    render(<FileCard name="file.txt" removable={true} />)
    const removeBtn = screen.queryByLabelText("Remove file")
    expect(removeBtn).toBeNull()
  })

  it("remove button is present in DOM when removable=true and onRemove provided", () => {
    render(
      <FileCard
        name="file.txt"
        removable={true}
        onRemove={mock(() => {})}
      />
    )
    const removeBtn = screen.getByLabelText("Remove file")
    expect(removeBtn).toBeTruthy()
  })

  it("clicking remove button calls onRemove callback", async () => {
    const user = userEvent.setup()
    const onRemove = mock(() => {})
    render(
      <FileCard
        name="file.txt"
        removable={true}
        onRemove={onRemove}
      />
    )

    const removeBtn = screen.getByLabelText("Remove file")
    await user.click(removeBtn)

    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  // ── clickable / open in new tab ───────────────────────────────────────────────

  it("clicking card with url and clickable=true opens url in new tab", async () => {
    const user = userEvent.setup()
    const openSpy = spyOn(window, "open").mockImplementation(() => null)

    render(
      <FileCard
        name="report.pdf"
        url="https://example.com/files/report.pdf"
        clickable={true}
      />
    )

    const btn = screen.getByRole("button", { name: /report\.pdf/i })
    await user.click(btn)

    // Browser fallback path of openExternalUrl (no Tauri runtime in tests).
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("https://example.com/files/report.pdf", "_blank", "noopener,noreferrer"))
    openSpy.mockRestore()
  })

  it("clicking card when clickable=false does not call window.open", async () => {
    const user = userEvent.setup()
    const openSpy = spyOn(window, "open").mockImplementation(() => null)

    render(
      <FileCard
        name="report.pdf"
        url="https://example.com/files/report.pdf"
        clickable={false}
      />
    )

    const btn = screen.getByRole("button", { name: /report\.pdf/i })
    await user.click(btn)

    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it("clicking card without url does not call window.open even if clickable=true", async () => {
    const user = userEvent.setup()
    const openSpy = spyOn(window, "open").mockImplementation(() => null)

    render(<FileCard name="report.pdf" clickable={true} />)

    const btn = screen.getByRole("button", { name: /report\.pdf/i })
    await user.click(btn)

    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it("button is disabled when clickable is false", () => {
    render(<FileCard name="file.txt" clickable={false} />)
    const btn = screen.getByRole("button", { name: /file\.txt/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it("button is not disabled when clickable is true", () => {
    render(
      <FileCard
        name="file.txt"
        url="https://example.com/file.txt"
        clickable={true}
      />
    )
    const btn = screen.getByRole("button", { name: /file\.txt/i })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })
})

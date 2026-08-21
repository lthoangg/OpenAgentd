import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InputComposer } from "@/components/InputComposer"

afterEach(cleanup)

// Helper to check if node `a` precedes node `b` in DOM order
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

// Helper to find the file preview wrapper by walking up from a text node
function findPreviewWrapper(textElement: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = textElement
  while (current) {
    const className = current.className
    if (typeof className === "string" && (className.includes("flex-nowrap") || className.includes("mt-3") || className.includes("mb-3"))) {
      return current
    }
    current = current.parentElement
  }
  return null
}

// Helper to find the input pill wrapper (the one with the relative class that contains the input container)
function findInputPillWrapper(): HTMLElement | null {
  const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
  if (!textarea) return null
  // Walk up: textarea → input container (flex div) → input pill wrapper (relative div)
  return textarea.parentElement?.parentElement ?? null
}

describe("InputComposer.filesBelow", () => {
  it("renders file preview above input by default (filesBelow=false)", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} />)

    // Upload a file using userEvent.upload
    const file = new File(["test content"], "notes.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    // Wait for file to appear
    const fileText = await screen.findByText("notes.txt")
    const previewWrapper = findPreviewWrapper(fileText)
    const inputPillWrapper = findInputPillWrapper()

    expect(previewWrapper).toBeTruthy()
    expect(inputPillWrapper).toBeTruthy()
    // Preview should precede input pill wrapper in DOM order
    expect(precedes(previewWrapper!, inputPillWrapper!)).toBe(true)
  })

  it("renders file preview below input when filesBelow={true}", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} filesBelow={true} />)

    // Upload a file
    const file = new File(["test content"], "notes.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    // Wait for file to appear
    const fileText = await screen.findByText("notes.txt")
    const previewWrapper = findPreviewWrapper(fileText)
    const inputPillWrapper = findInputPillWrapper()

    expect(previewWrapper).toBeTruthy()
    expect(inputPillWrapper).toBeTruthy()
    // Preview should follow input pill wrapper in DOM order
    expect(precedes(inputPillWrapper!, previewWrapper!)).toBe(true)
  })

  it("applies mb-3 margin class when filesBelow={false}", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} filesBelow={false} />)

    // Upload a file
    const file = new File(["test content"], "notes.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    const fileText = await screen.findByText("notes.txt")
    let current: HTMLElement | null = fileText
    let foundMargin = false
    while (current) {
      if (current.className && typeof current.className === "string" && current.className.includes("mb-3")) {
        foundMargin = true
        break
      }
      current = current.parentElement
    }
    expect(foundMargin).toBe(true)
  })

  it("applies mt-3 margin class when filesBelow={true}", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} filesBelow={true} />)

    // Upload a file
    const file = new File(["test content"], "notes.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    const fileText = await screen.findByText("notes.txt")
    let current: HTMLElement | null = fileText
    let foundMargin = false
    while (current) {
      if (current.className && typeof current.className === "string" && current.className.includes("mt-3")) {
        foundMargin = true
        break
      }
      current = current.parentElement
    }
    expect(foundMargin).toBe(true)
  })

  it("renders previews row with flex-nowrap and w-max classes", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} />)

    // Upload 2 files
    const file1 = new File(["content1"], "file1.txt", { type: "text/plain" })
    const file2 = new File(["content2"], "file2.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, [file1, file2])

    // Find the inner row by looking for the element with flex-nowrap
    await screen.findByText("file1.txt")
    let rowElement: HTMLElement | null = null
    const allDivs = document.querySelectorAll("div")
    for (const div of allDivs) {
      const className = div.className
      if (typeof className === "string" && className.includes("flex-nowrap") && className.includes("w-max")) {
        rowElement = div
        break
      }
    }

    expect(rowElement).toBeTruthy()
    expect(rowElement!.className).toContain("flex-nowrap")
    expect(rowElement!.className).toContain("w-max")
  })

  it("wraps previews in a horizontally scrollable container", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} />)

    // Upload a file
    const file = new File(["test"], "test.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    await screen.findByText("test.txt")
    let scrollContainer: HTMLElement | null = null
    const allDivs = document.querySelectorAll("div")
    for (const div of allDivs) {
      const className = div.className
      if (typeof className === "string" && className.includes("overflow-x-auto")) {
        scrollContainer = div
        break
      }
    }

    expect(scrollContainer).toBeTruthy()
    expect(scrollContainer!.className).toContain("overflow-x-auto")
  })

  it("wraps each preview item in shrink-0 container", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} />)

    // Upload 3 files
    const files = [
      new File(["1"], "file1.txt", { type: "text/plain" }),
      new File(["2"], "file2.txt", { type: "text/plain" }),
      new File(["3"], "file3.txt", { type: "text/plain" }),
    ]
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, files)

    await screen.findByText("file1.txt")
    const shrinkWrappers = document.querySelectorAll("div[class*='shrink-0']")
    // Count shrink-0 wrappers that are direct parents of FileCard or ImageAttachment
    let count = 0
    for (const wrapper of shrinkWrappers) {
      const child = wrapper.firstElementChild
      if (child && (child.className.includes("group") || child.tagName === "IMG")) {
        count++
      }
    }
    expect(count).toBe(3)
  })

  it("invokes renderDragHandle and renders its output", () => {
    const onSubmit = () => {}
    const renderDragHandle = () => <button aria-label="test-handle">H</button>
    render(<InputComposer onSubmit={onSubmit} renderDragHandle={renderDragHandle} />)

    const handle = screen.getByRole("button", { name: "test-handle" })
    expect(handle).toBeTruthy()
  })

  it("renders renderDragHandle output above the input pill", () => {
    const onSubmit = () => {}
    const renderDragHandle = () => <button aria-label="test-handle">H</button>
    render(<InputComposer onSubmit={onSubmit} renderDragHandle={renderDragHandle} />)

    const handle = screen.getByRole("button", { name: "test-handle" })
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const inputContainer = textarea.parentElement

    expect(handle).toBeTruthy()
    expect(inputContainer).toBeTruthy()
    // Handle and input container are siblings within the input pill wrapper
    // Handle should precede input container
    expect(precedes(handle, inputContainer!)).toBe(true)
  })

  it("does not clobber attach button when renderDragHandle is provided", () => {
    const onSubmit = () => {}
    const renderDragHandle = () => <button aria-label="test-handle">H</button>
    render(<InputComposer onSubmit={onSubmit} renderDragHandle={renderDragHandle} />)

    const handle = screen.getByRole("button", { name: "test-handle" })
    const attachButton = screen.getByRole("button", { name: /attach file/i })

    expect(handle).toBeTruthy()
    expect(attachButton).toBeTruthy()
  })

  it("renders normally when renderDragHandle is not provided", () => {
    const onSubmit = () => {}
    render(<InputComposer onSubmit={onSubmit} />)

    const textarea = screen.getByLabelText("Message input")
    expect(textarea).toBeTruthy()
  })

  it("maintains DOM order: handle → input → preview when filesBelow={true} with renderDragHandle", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    const renderDragHandle = () => <button aria-label="test-handle">H</button>
    render(<InputComposer onSubmit={onSubmit} filesBelow={true} renderDragHandle={renderDragHandle} />)

    // Upload a file
    const file = new File(["test"], "test.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    const handle = screen.getByRole("button", { name: "test-handle" })
    const fileText = await screen.findByText("test.txt")
    const previewWrapper = findPreviewWrapper(fileText)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const inputContainer = textarea.parentElement
    const inputPillWrapper = findInputPillWrapper()

    expect(handle).toBeTruthy()
    expect(previewWrapper).toBeTruthy()
    expect(inputContainer).toBeTruthy()
    expect(inputPillWrapper).toBeTruthy()

    // Order: handle → input container (siblings) → input pill wrapper → preview
    expect(precedes(handle, inputContainer!)).toBe(true)
    expect(precedes(inputPillWrapper!, previewWrapper!)).toBe(true)
  })
})

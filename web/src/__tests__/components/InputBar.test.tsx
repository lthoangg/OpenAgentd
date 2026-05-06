import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import { postTranscribe } from "@/api/client"
import { InputBar } from "@/components/InputBar"
import type { InputBarHandle } from "@/components/InputBar"
import type { AgentCapabilities } from "@/api/types"

const mockPostTranscribe = postTranscribe as unknown as {
  mockImplementation?: (impl: () => Promise<{ text: string }>) => void
}

const server = setupServer()

let originalFetch: typeof fetch | undefined

class MockMediaRecorder extends EventTarget {
  mimeType = "audio/webm"
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start() {
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) })
  }

  stop() {
    this.onstop?.()
  }
}

function makeStreamStub() {
  return {
    getTracks: () => [{ stop: () => {} }],
  }
}

beforeEach(() => {
  mockPostTranscribe.mockImplementation?.(async () => ({ text: "world" }))

  server.listen()
  server.use(
    http.post("http://localhost/api/speech/transcribe", () => HttpResponse.json({ text: "world" })),
  )

  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/")) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error("fetch unavailable"))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error("fetch unavailable"))
  }) as typeof fetch

  ;(global as Record<string, unknown>).MediaRecorder = MockMediaRecorder
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => makeStreamStub() },
    configurable: true,
    writable: true,
  })
})

afterEach(cleanup)

afterEach(() => {
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

describe("InputBar", () => {
  it("renders textarea with placeholder", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} placeholder="Type here..." />)

    const textarea = screen.getByPlaceholderText("Type here...")
    expect(textarea).toBeTruthy()
  })

  it("uses default placeholder when not provided", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} />)

    const textarea = screen.getByPlaceholderText("Message OpenAgentd…")
    expect(textarea).toBeTruthy()
  })

  it("calls onSubmit with trimmed text on Enter", async () => {
    const user = userEvent.setup()
    let submittedText = ""
    const onSubmit = (text: string) => {
      submittedText = text
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "  hello world  ")
    await user.keyboard("{Enter}")

    expect(submittedText).toBe("hello world")
  })

  it("does not submit on Shift+Enter (allows newline)", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    const onSubmit = () => {
      submitCount++
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "line1")
    await user.keyboard("{Shift>}{Enter}{/Shift}")

    expect(submitCount).toBe(0)
    // Should have newline in textarea
    expect((textarea as HTMLTextAreaElement).value).toContain("\n")
  })

  it("does not submit when input is empty", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    const onSubmit = () => {
      submitCount++
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input")

    await user.click(textarea)
    await user.keyboard("{Enter}")
    expect(submitCount).toBe(0)
  })

  it("does not submit when input is only whitespace", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    const onSubmit = () => {
      submitCount++
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "   ")
    await user.keyboard("{Enter}")
    expect(submitCount).toBe(0)
  })

  it("disables send button when disabled prop is true", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} disabled={true} />)

    const button = screen.getByLabelText("Send message")
    expect(button.hasAttribute("disabled")).toBe(true)
  })

  it("enables send button when disabled prop is false and text present", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} disabled={false} />)

    const textarea = screen.getByLabelText("Message input")
    const button = screen.getByLabelText("Send message")

    // Button is disabled when no text
    expect(button.hasAttribute("disabled")).toBe(true)

    // Add text
    await user.type(textarea, "test")

    // Button should be enabled now
    expect(button.hasAttribute("disabled")).toBe(false)
  })

  it("uses custom placeholder in idle state", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} placeholder="Ask anything…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.placeholder).toBe("Ask anything…")
  })

  it("overrides placeholder with waiting status when disabled", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} disabled={true} placeholder="Ask anything…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.placeholder).toBe("Waiting for response…")
  })

  it("overrides placeholder with streaming status when streaming", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} isStreaming={true} placeholder="Ask anything…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.placeholder).toMatch(/interrupt/)
  })

  it("exposes keyboard shortcuts via send button tooltip", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} />)

    const sendButton = screen.getByLabelText("Send message")
    expect(sendButton.getAttribute("title")).toMatch(/Enter/)
    expect(sendButton.getAttribute("title")).toMatch(/Shift\+Enter/)
  })

  it("clears input after submit", async () => {
    const user = userEvent.setup()
    const onSubmit = () => {}

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "test message")
    expect(textarea.value).toBe("test message")

    await user.keyboard("{Enter}")
    expect(textarea.value).toBe("")
  })

  it("has correct aria-label on textarea", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} />)

    const textarea = screen.getByLabelText("Message input")
    expect(textarea).toBeTruthy()
  })

  it("has correct aria-label on button", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} />)

    const button = screen.getByLabelText("Send message")
    expect(button).toBeTruthy()
  })

  it("disables textarea when disabled prop is true", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} disabled={true} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  it("enables textarea when disabled prop is false", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} disabled={false} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  it("calls onSubmit when send button is clicked", async () => {
    const user = userEvent.setup()
    let submittedText = ""
    const onSubmit = (text: string) => {
      submittedText = text
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input")
    const button = screen.getByLabelText("Send message")

    await user.type(textarea, "click submit")
    await user.click(button)

    expect(submittedText).toBe("click submit")
  })

  it("does not call onSubmit when disabled and button clicked", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    const onSubmit = () => {
      submitCount++
    }

    render(<InputBar onSubmit={onSubmit} disabled={true} />)
    const textarea = screen.getByLabelText("Message input")
    const button = screen.getByLabelText("Send message")

    await user.type(textarea, "test")
    await user.click(button)

    expect(submitCount).toBe(0)
  })

  it("autoFocus textarea when autoFocus prop is true", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} autoFocus={true} />)

    const textarea = screen.getByLabelText("Message input")
    expect(document.activeElement).toBe(textarea)
  })

  describe("voice transcript insertion", () => {
    it("appends transcript to existing draft with space", async () => {
      const user = userEvent.setup()
      render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)

      const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
      await user.type(textarea, "hello")
      await user.click(screen.getByLabelText("Start voice input"))
      await user.click(screen.getByLabelText("Stop recording"))

      await screen.findByLabelText("Start voice input")
      expect(textarea.value).toBe("hello world")
    })

    it("inserts transcript when input is empty", async () => {
      const user = userEvent.setup()
      render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)

      const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
      await user.click(screen.getByLabelText("Start voice input"))
      await user.click(screen.getByLabelText("Stop recording"))

      await screen.findByLabelText("Start voice input")
      expect(textarea.value).toBe("world")
    })

    it("strips trailing whitespace from existing draft before appending", async () => {
      const user = userEvent.setup()
      render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)

      const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
      await user.type(textarea, "hello   ")
      await user.click(screen.getByLabelText("Start voice input"))
      await user.click(screen.getByLabelText("Stop recording"))

      await screen.findByLabelText("Start voice input")
      expect(textarea.value).toBe("hello world")
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage: useImperativeHandle, capabilities, file handling, drag-drop
// ─────────────────────────────────────────────────────────────────────────────

describe("InputBar — useImperativeHandle (focus method)", () => {
  it("exposes a focus() method via ref that focuses the textarea", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)

    const textarea = screen.getByLabelText("Message input")
    // Blur first to ensure focus is not already on the textarea
    ;(textarea as HTMLTextAreaElement).blur()

    act(() => {
      ref.current?.focus()
    })

    expect(document.activeElement).toBe(textarea)
  })

  it("ref is populated after mount", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    expect(ref.current).toBeTruthy()
    expect(typeof ref.current?.focus).toBe("function")
  })
})

describe("InputBar — buildAcceptString (hidden file input accept attribute)", () => {
  it("includes only text types when no capabilities provided", () => {
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("text/plain")
    expect(accept).toContain(".txt")
    expect(accept).toContain("application/json")
    expect(accept).not.toContain("image/*")
    expect(accept).not.toContain("application/pdf")
    expect(accept).not.toContain("audio/*")
    expect(accept).not.toContain("video/*")
  })

  it("includes image/* when capabilities.vision is true", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("image/*")
    expect(accept).not.toContain("application/pdf")
  })

  it("includes pdf and docx types when capabilities.document_text is true", () => {
    const caps: AgentCapabilities = { input: { vision: false, document_text: true, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("application/pdf")
    expect(accept).toContain(".pdf")
    expect(accept).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(accept).toContain(".docx")
  })

  it("includes audio/* when capabilities.audio is true", () => {
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: true, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("audio/*")
    expect(accept).not.toContain("video/*")
  })

  it("includes video/* when capabilities.video is true", () => {
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: true }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("video/*")
    expect(accept).not.toContain("audio/*")
  })

  it("includes all types when all capabilities are enabled", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: true, audio: true, video: true }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("image/*")
    expect(accept).toContain("application/pdf")
    expect(accept).toContain("audio/*")
    expect(accept).toContain("video/*")
  })
})

describe("InputBar — capabilities prop", () => {
  // The `capabilities` prop drives file-type filtering (covered in the
  // `isFileTypeAllowed / addFile filtering` suite below) and the paperclip
  // `accept` attribute. It no longer affects hint text because the hint was
  // removed in favor of placeholder-based status messages and a send-button
  // tooltip.
  it("renders without crashing when vision is enabled", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })

  it("renders without crashing when no capabilities are provided", () => {
    render(<InputBar onSubmit={() => {}} />)
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })
})

describe("InputBar — isFileTypeAllowed / addFile filtering", () => {
  it("always allows plain text files by MIME type", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("notes.txt")).toBeTruthy()
  })

  it("always allows JSON files by MIME type", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(['{"key":"val"}'], "data.json", { type: "application/json" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("data.json")).toBeTruthy()
  })

  it("always allows .md files by extension even with no MIME type", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["# Title"], "readme.md", { type: "" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("readme.md")).toBeTruthy()
  })

  it("allows image files when vision capability is enabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["img"], "photo.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    // ImageAttachment renders an img element
    expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
  })

  it("rejects image files when vision capability is disabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["img"], "photo.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull()
  })

  it("allows PDF files when document_text capability is enabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: true, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("report.pdf")).toBeTruthy()
  })

  it("allows DOCX files when document_text capability is enabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: true, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["docx"], "doc.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("doc.docx")).toBeTruthy()
  })

  it("rejects PDF files when document_text capability is disabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByText("report.pdf")).toBeNull()
  })

  it("allows audio files when audio capability is enabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: true, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["audio"], "clip.mp3", { type: "audio/mpeg" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("clip.mp3")).toBeTruthy()
  })

  it("rejects audio files when audio capability is disabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["audio"], "clip.mp3", { type: "audio/mpeg" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByText("clip.mp3")).toBeNull()
  })

  it("allows video files when video capability is enabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: true }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["video"], "movie.mp4", { type: "video/mp4" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("movie.mp4")).toBeTruthy()
  })

  it("rejects video files when video capability is disabled", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["video"], "movie.mp4", { type: "video/mp4" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByText("movie.mp4")).toBeNull()
  })

  it("rejects unknown file types regardless of capabilities", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: true, audio: true, video: true }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["data"], "archive.zip", { type: "application/zip" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByText("archive.zip")).toBeNull()
  })
})

describe("InputBar — file previews (ImageAttachment and FileCard)", () => {
  it("renders ImageAttachment for image files", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["img"], "photo.jpg", { type: "image/jpeg" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    // ImageAttachment renders an <img> with alt = file.name
    const img = screen.getByRole("img", { name: "photo.jpg" })
    expect(img).toBeTruthy()
  })

  it("renders FileCard for non-image files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["data"], "data.csv", { type: "text/csv" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("data.csv")).toBeTruthy()
    // No img element should be present for a CSV
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("renders FileCard for PDF files", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: false, document_text: true, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("report.pdf")).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("renders multiple file previews when multiple files are added", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const img1 = new File(["img1"], "first.png", { type: "image/png" })
    const img2 = new File(["img2"], "second.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, [img1, img2])

    expect(screen.getByRole("img", { name: "first.png" })).toBeTruthy()
    expect(screen.getByRole("img", { name: "second.png" })).toBeTruthy()
  })

  it("shows no file previews when no files are attached", () => {
    render(<InputBar onSubmit={() => {}} />)
    // No img elements and no remove buttons
    expect(screen.queryByRole("img")).toBeNull()
    expect(screen.queryByLabelText("Remove image")).toBeNull()
    expect(screen.queryByLabelText("Remove file")).toBeNull()
  })
})

describe("InputBar — removeFile", () => {
  it("removes a file preview when the remove button is clicked", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["data"], "notes.txt", { type: "text/plain" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    // File card is visible
    expect(screen.getByText("notes.txt")).toBeTruthy()

    // Click the remove button
    const removeBtn = screen.getByLabelText("Remove file")
    await user.click(removeBtn)

    // File card should be gone
    expect(screen.queryByText("notes.txt")).toBeNull()
  })

  it("removes only the targeted image when multiple images are attached", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const img1 = new File(["img1"], "keep.png", { type: "image/png" })
    const img2 = new File(["img2"], "remove.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, [img1, img2])

    expect(screen.getByRole("img", { name: "keep.png" })).toBeTruthy()
    expect(screen.getByRole("img", { name: "remove.png" })).toBeTruthy()

    // Remove buttons are rendered by ImageAttachment (aria-label="Remove image")
    const removeBtns = screen.getAllByLabelText("Remove image")
    // Click the second remove button (for remove.png)
    await user.click(removeBtns[1])

    expect(screen.getByRole("img", { name: "keep.png" })).toBeTruthy()
    expect(screen.queryByRole("img", { name: "remove.png" })).toBeNull()
  })

  it("files are cleared after submit", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["data"], "notes.txt", { type: "text/plain" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)
    expect(screen.getByText("notes.txt")).toBeTruthy()

    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "send with file")
    await user.keyboard("{Enter}")

    expect(screen.queryByText("notes.txt")).toBeNull()
  })

  it("passes files to onSubmit callback", async () => {
    const user = userEvent.setup()
    let capturedFiles: File[] | undefined
    const onSubmit = (_msg: string, files?: File[]) => {
      capturedFiles = files
    }
    render(<InputBar onSubmit={onSubmit} />)

    const file = new File(["data"], "notes.txt", { type: "text/plain" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "with attachment")
    await user.keyboard("{Enter}")

    expect(capturedFiles).toBeTruthy()
    expect(capturedFiles?.length).toBe(1)
    expect(capturedFiles?.[0].name).toBe("notes.txt")
  })
})

describe("InputBar — character count display", () => {
  it("does not show character count when text is ≤500 chars", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "short text")

    // Character count span should not be present
    expect(screen.queryByText("10")).toBeNull()
  })

  it("shows character count when text exceeds 500 chars", async () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const longText = "a".repeat(501)

    act(() => {
      fireEvent.change(textarea, { target: { value: longText } })
    })

    expect(screen.getByText("501")).toBeTruthy()
  })

  it("shows character count in error color when text exceeds 2000 chars", async () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const veryLongText = "a".repeat(2001)

    act(() => {
      fireEvent.change(textarea, { target: { value: veryLongText } })
    })

    const countEl = screen.getByText("2001")
    expect(countEl).toBeTruthy()
    // Should have error color class
    expect(countEl.className).toContain("color-error")
  })

  it("shows character count in muted color when between 501 and 2000 chars", async () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const mediumText = "a".repeat(600)

    act(() => {
      fireEvent.change(textarea, { target: { value: mediumText } })
    })

    const countEl = screen.getByText("600")
    expect(countEl).toBeTruthy()
    expect(countEl.className).not.toContain("color-error")
  })
})

describe("InputBar — attachment button (paperclip)", () => {
  it("renders the attachment button with correct aria-label", () => {
    render(<InputBar onSubmit={() => {}} />)
    const btn = screen.getByLabelText("Attach file")
    expect(btn).toBeTruthy()
  })

  it("attachment button is disabled when disabled prop is true", () => {
    render(<InputBar onSubmit={() => {}} disabled={true} />)
    const btn = screen.getByLabelText("Attach file") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it("attachment button is enabled when disabled prop is false", () => {
    render(<InputBar onSubmit={() => {}} disabled={false} />)
    const btn = screen.getByLabelText("Attach file") as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it("clicking attachment button triggers the hidden file input", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    let clicked = false
    fileInput.addEventListener("click", () => { clicked = true })

    const btn = screen.getByLabelText("Attach file")
    await user.click(btn)

    expect(clicked).toBe(true)
  })
})

describe("InputBar — send button click handler", () => {
  it("send button calls onSubmit with current text and files", async () => {
    const user = userEvent.setup()
    let submittedMsg = ""
    let submittedFiles: File[] | undefined
    const onSubmit = (msg: string, files?: File[]) => {
      submittedMsg = msg
      submittedFiles = files
    }
    render(<InputBar onSubmit={onSubmit} />)

    const file = new File(["data"], "attach.txt", { type: "text/plain" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "hello with file")

    const sendBtn = screen.getByLabelText("Send message")
    await user.click(sendBtn)

    expect(submittedMsg).toBe("hello with file")
    expect(submittedFiles?.length).toBe(1)
    expect(submittedFiles?.[0].name).toBe("attach.txt")
  })

  it("send button is disabled when there is no text even with files attached", async () => {
    const user = userEvent.setup()
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const file = new File(["img"], "photo.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    const sendBtn = screen.getByLabelText("Send message") as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })
})

describe("InputBar — handleDrop (drag-and-drop)", () => {
  it("adds an allowed file when dropped onto the input container", () => {
    render(<InputBar onSubmit={() => {}} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    const file = new File(["data"], "dropped.txt", { type: "text/plain" })
    const dataTransfer = { files: [file] }

    act(() => {
      fireEvent.dragEnter(container, { dataTransfer })
      fireEvent.dragOver(container, { dataTransfer })
      fireEvent.drop(container, { dataTransfer })
    })

    expect(screen.getByText("dropped.txt")).toBeTruthy()
  })

  it("rejects a disallowed file type on drop", () => {
    render(<InputBar onSubmit={() => {}} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    const file = new File(["data"], "archive.zip", { type: "application/zip" })
    const dataTransfer = { files: [file] }

    act(() => {
      fireEvent.drop(container, { dataTransfer })
    })

    expect(screen.queryByText("archive.zip")).toBeNull()
  })

  it("adds image file on drop when vision capability is enabled", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    const file = new File(["img"], "dragged.jpg", { type: "image/jpeg" })
    const dataTransfer = { files: [file] }

    act(() => {
      fireEvent.drop(container, { dataTransfer })
    })

    expect(screen.getByRole("img", { name: "dragged.jpg" })).toBeTruthy()
  })

  it("handles dragEnter and dragLeave without errors", () => {
    render(<InputBar onSubmit={() => {}} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    act(() => {
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } })
      fireEvent.dragLeave(container, { dataTransfer: { files: [] } })
    })

    // No crash — component still renders
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })

  it("handles dragOver without errors", () => {
    render(<InputBar onSubmit={() => {}} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    act(() => {
      fireEvent.dragOver(container, { dataTransfer: { files: [] } })
    })

    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })

  it("drops multiple files and adds all allowed ones", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const container = screen.getByLabelText("Message input").closest("div") as HTMLElement

    const file1 = new File(["txt"], "notes.txt", { type: "text/plain" })
    const file2 = new File(["img"], "photo.png", { type: "image/png" })
    const file3 = new File(["zip"], "archive.zip", { type: "application/zip" })
    const dataTransfer = { files: [file1, file2, file3] }

    act(() => {
      fireEvent.drop(container, { dataTransfer })
    })

    expect(screen.getByText("notes.txt")).toBeTruthy()
    expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
    expect(screen.queryByText("archive.zip")).toBeNull()
  })
})

describe("InputBar — handlePaste (clipboard paste with files)", () => {
  it("adds an image file pasted from clipboard when vision is enabled", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)

    const textarea = screen.getByLabelText("Message input")
    const file = new File(["img"], "pasted.png", { type: "image/png" })

    const clipboardData = {
      items: [
        {
          kind: "file",
          getAsFile: () => file,
        },
      ],
    }

    act(() => {
      fireEvent.paste(textarea, { clipboardData })
    })

    expect(screen.getByRole("img", { name: "pasted.png" })).toBeTruthy()
  })

  it("does not add a file pasted from clipboard when type is not allowed", () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input")
    const file = new File(["img"], "pasted.png", { type: "image/png" })

    const clipboardData = {
      items: [
        {
          kind: "file",
          getAsFile: () => file,
        },
      ],
    }

    act(() => {
      fireEvent.paste(textarea, { clipboardData })
    })

    expect(screen.queryByRole("img", { name: "pasted.png" })).toBeNull()
  })

  it("ignores non-file clipboard items", () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input")

    const clipboardData = {
      items: [
        {
          kind: "string",
          getAsFile: () => null,
        },
      ],
    }

    act(() => {
      fireEvent.paste(textarea, { clipboardData })
    })

    // No file previews should appear
    expect(screen.queryByLabelText("Remove file")).toBeNull()
    expect(screen.queryByLabelText("Remove image")).toBeNull()
  })

  it("handles paste with no clipboardData items gracefully", () => {
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input")

    act(() => {
      fireEvent.paste(textarea, { clipboardData: { items: null } })
    })

    // No crash — component still renders
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })
})

describe("InputBar — handleFileSelect (file input change)", () => {
  it("adds a valid file selected via the file input", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["data"], "selected.csv", { type: "text/csv" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("selected.csv")).toBeTruthy()
  })

  it("rejects a disallowed file selected via the file input", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["data"], "binary.exe", { type: "application/octet-stream" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.queryByText("binary.exe")).toBeNull()
  })

  it("allows selecting multiple files at once via the file input", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file1 = new File(["a"], "first.txt", { type: "text/plain" })
    const file2 = new File(["b"], "second.csv", { type: "text/csv" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, [file1, file2])

    expect(screen.getByText("first.txt")).toBeTruthy()
    expect(screen.getByText("second.csv")).toBeTruthy()
  })

  it("file input has multiple attribute set", () => {
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
  })

  it("file input is hidden from assistive technology", () => {
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.getAttribute("aria-hidden")).toBe("true")
  })
})

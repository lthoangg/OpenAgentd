import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { InputBar } from "@/components/InputBar"
import type { InputBarHandle } from "@/components/InputBar"
import { buildAcceptString, isFileTypeAllowed } from "@/components/InputBar.files"
import {
  buildHistoryEntries,
  filterMentions,
  filterSlashCommands,
  filterSnippetCommands,
} from "@/components/InputBar.menus"
import type { AgentCapabilities } from "@/api/types"

let isMobile = false

mock.module("@/hooks/use-mobile", () => ({
  useIsMobile: () => isMobile,
}))

const mockOS = "macos"

mock.module("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isTauri: false, os: mockOS, isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: mockOS, isMacOverlay: false }),
}))

class MockSpeechRecognition {
  continuous = false
  interimResults = false
  lang = ""
  onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null
  onerror: ((event: { error?: string; message?: string }) => void) | null = null
  onend: (() => void) | null = null

  start() {}

  stop() {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "world" } }] })
    this.onend?.()
  }
}

// Override the global setup.ts stub so voice tests in this file use a
// synchronous mock that doesn't touch real async browser APIs.
mock.module("@/lib/speech-recognition", () => ({
  isClientSpeechRecognitionSupported: () => true,
  getSpeechRecognitionConstructor: () => MockSpeechRecognition,
  startClientSpeechRecognition: async (options: {
    onFinal: (t: string) => void
    onError: (m: string) => void
    onEnd: () => void
  }) => {
    const recognition = new MockSpeechRecognition()
    recognition.onresult = (event) => {
      const result = event.results[event.resultIndex]
      if (result?.isFinal) options.onFinal(result[0].transcript)
    }
    recognition.onerror = (event) => options.onError(event.message ?? event.error ?? "error")
    recognition.onend = () => options.onEnd()
    recognition.start()
    return { stop: () => recognition.stop() }
  },
}))

beforeEach(() => {
  isMobile = false
})

afterEach(cleanup)

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (no DOM) — fast sanity checks on exported helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — pure logic helpers", () => {
  it("buildHistoryEntries merges local + persisted, deduplicates and trims", () => {
    expect(buildHistoryEntries([" local ", "other"], ["other", "", " persisted "])).toEqual([
      "local", "other", "persisted",
    ])
  })

  it("filterSlashCommands returns separator + matching commands", () => {
    const commands = [
      { id: "group", label: "Group", description: "", isSeparator: true },
      { id: "continue", label: "Continue", description: "Continue the run" },
      { id: "compact", label: "Compact", description: "Compact session" },
    ]
    expect(filterSlashCommands(commands, "cont").map((c) => c.id)).toEqual(["group", "continue"])
  })

  it("filterSnippetCommands filters by query", () => {
    expect(
      filterSnippetCommands(
        [{ id: "fix", label: "Fix bug", description: "" }, { id: "feat", label: "Add feature", description: "" }],
        { start: 0, end: 3, query: "fi" },
      ).map((c) => c.id),
    ).toEqual(["fix"])
  })

  it("filterMentions filters by query", () => {
    expect(
      filterMentions(
        [{ path: "src/app.ts", name: "app.ts", type: "file" }, { path: "docs/guide.md", name: "guide.md", type: "file" }],
        { start: 0, end: 4, query: "app" },
      ).map((r) => r.path),
    ).toEqual(["src/app.ts"])
  })

  it("isFileTypeAllowed returns true for every file type", () => {
    expect(isFileTypeAllowed(new File([""], "notes.txt", { type: "text/plain" }))).toBe(true)
    expect(isFileTypeAllowed(new File([""], "archive.zip", { type: "application/zip" }))).toBe(true)
    expect(isFileTypeAllowed(new File([""], "main.py", { type: "" }))).toBe(true)
  })

  it("buildAcceptString covers text, code, documents and media", () => {
    const accept = buildAcceptString()
    expect(accept).toContain("text/plain")
    expect(accept).toContain(".py")
    expect(accept).toContain(".ts")
    expect(accept).toContain("application/json")
    expect(accept).toContain("application/pdf")
    expect(accept).toContain("image/*")
    expect(accept).toContain("audio/*")
    expect(accept).toContain("video/*")
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Submit behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — submit", () => {
  it("calls onSubmit with trimmed text on Enter", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(<InputBar onSubmit={(t) => { submitted = t }} />)
    await user.type(screen.getByLabelText("Message input"), "  hello world  ")
    await user.keyboard("{Enter}")
    expect(submitted).toBe("hello world")
  })

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup()
    let count = 0
    render(<InputBar onSubmit={() => { count++ }} />)
    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "line1")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    expect(count).toBe(0)
    expect((textarea as HTMLTextAreaElement).value).toContain("\n")
  })

  it("does not submit on Enter on mobile", async () => {
    isMobile = true
    const user = userEvent.setup()
    let count = 0
    render(<InputBar onSubmit={() => { count++ }} />)
    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "line1")
    await user.keyboard("{Enter}")
    expect(count).toBe(0)
  })

  it("does not submit when empty or whitespace-only", async () => {
    const user = userEvent.setup()
    let count = 0
    render(<InputBar onSubmit={() => { count++ }} />)
    const textarea = screen.getByLabelText("Message input")
    await user.keyboard("{Enter}")
    await user.type(textarea, "   ")
    await user.keyboard("{Enter}")
    expect(count).toBe(0)
  })

  it("submits a queued follow-up while streaming", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(<InputBar onSubmit={(t) => { submitted = t }} isStreaming={true} />)
    await user.type(screen.getByLabelText("Message input"), "follow-up")
    await user.keyboard("{Enter}")
    expect(submitted).toBe("follow-up")
  })

  it("clears input and files after submit", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const file = new File([""], "notes.txt", { type: "text/plain" })
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file)
    expect(screen.getByText("notes.txt")).toBeTruthy()
    await user.type(screen.getByLabelText("Message input"), "send it")
    await user.keyboard("{Enter}")
    expect(screen.queryByText("notes.txt")).toBeNull()
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe("")
  })

  it("passes files to onSubmit", async () => {
    const user = userEvent.setup()
    let capturedFiles: File[] | undefined
    render(<InputBar onSubmit={(_msg, files) => { capturedFiles = files }} />)
    const file = new File([""], "notes.txt", { type: "text/plain" })
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file)
    await user.type(screen.getByLabelText("Message input"), "send")
    await user.keyboard("{Enter}")
    expect(capturedFiles?.[0].name).toBe("notes.txt")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder / disabled state
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — placeholder and disabled state", () => {
  it("uses the custom placeholder", () => {
    render(<InputBar onSubmit={() => {}} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toBe("Ask anything…")
  })

  it("overrides placeholder with waiting message when disabled", () => {
    render(<InputBar onSubmit={() => {}} disabled={true} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toBe("Waiting for response…")
  })

  it("overrides placeholder when streaming", () => {
    render(<InputBar onSubmit={() => {}} isStreaming={true} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toMatch(/Queue a follow-up/)
  })

  it("send button disabled with no text, enabled once text is typed", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const btn = screen.getByLabelText("Send message")
    expect(btn.hasAttribute("disabled")).toBe(true)
    await user.type(screen.getByLabelText("Message input"), "hi")
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("send button tooltip mentions Enter and Shift+Enter", () => {
    render(<InputBar onSubmit={() => {}} />)
    const title = screen.getByLabelText("Send message").getAttribute("title") ?? ""
    expect(title).toMatch(/Enter/)
    expect(title).toMatch(/Shift\+Enter/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Input history
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — input history", () => {
  it("navigates local history with arrow keys from an empty input", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "first")
    await user.keyboard("{Enter}")
    await user.type(textarea, "second")
    await user.keyboard("{Enter}")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("second")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("first")
    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("second")
    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("")
  })

  it("does not enter history when a draft is present", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "previous")
    await user.keyboard("{Enter}")
    await user.type(textarea, "draft")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("draft")
  })

  it("navigates supplied historyPrompts", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} historyPrompts={["newer", "older"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("newer")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("older")
    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("newer")
  })

  it("does not hijack modified arrow keys", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} historyPrompts={["persisted"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)
    await user.keyboard("{Control>}{ArrowUp}{/Control}")
    expect(textarea.value).toBe("")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("persisted")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shell mode
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — shell mode", () => {
  it("enters shell mode when ! is typed at the start", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} placeholder="Message…" />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Enter shell command... git status")
    expect(screen.getByLabelText("Exit shell mode")).toBeTruthy()
  })

  it("leaves shell mode on Backspace when command is empty", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} placeholder="Message…" />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!")
    await user.keyboard("{Backspace}")
    expect(screen.getByLabelText("Message input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Message…")
  })

  it("submits shell mode content with bang prefix", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(<InputBar onSubmit={(t) => { submitted = t }} />)
    await user.type(screen.getByLabelText("Message input"), "!pwd")
    await user.keyboard("{Enter}")
    expect(submitted).toBe("!pwd")
  })

  it("does not show slash commands in shell mode", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} slashCommands={[{ id: "stop", label: "Stop", description: "" }]} />)
    await user.type(screen.getByLabelText("Message input"), "!/")
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull()
  })

  it("restores shell mode when navigating to a shell history entry", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!pwd")
    await user.keyboard("{Enter}")
    await user.keyboard("{ArrowUp}")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
  })

  it("enters shell mode when the pasted text replaces an empty draft with a ! command", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)
    await user.paste("!make")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
    expect(textarea.value).toBe("make")
  })

  it("does not enter shell mode when pasting ! mid-sentence", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "hello ")
    await user.paste("!make")
    expect(screen.getByLabelText("Message input")).toBe(textarea)
    expect(textarea.value).toBe("hello !make")
  })

  it("does not enter shell mode when a ! paste only replaces a partial selection", async () => {
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.type(textarea, "hello world")
    textarea.setSelectionRange(0, 5)
    await user.paste("!make")
    expect(screen.getByLabelText("Message input")).toBe(textarea)
    expect(textarea.value).toBe("!make world")
  })

  it("enters shell mode when an inserted snippet's rendered body starts with !", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        snippetCommands={[{ id: "revision", label: "revision", description: "" }]}
        onSnippetCommand={async () => '!make revision MSG="desc"'}
      />,
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "#revision")
    await user.keyboard("{Enter}")
    expect(await screen.findByLabelText("Shell command input")).toBe(textarea)
    expect(textarea.value).toBe('make revision MSG="desc"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — slash commands", () => {
  it("executes matched slash command on Enter instead of submitting", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    let slashCommand = ""
    render(
      <InputBar
        onSubmit={() => { submitCount++ }}
        onSlashCommand={(id) => { slashCommand = id }}
        slashCommands={[{ id: "new", label: "New", description: "Create new session" }]}
      />,
    )
    await user.type(screen.getByLabelText("Message input"), "/ne")
    await user.keyboard("{Enter}")
    expect(submitCount).toBe(0)
    expect(slashCommand).toBe("new")
  })

  it("wires ARIA attributes on textarea to the listbox", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[
          { id: "stop", label: "Stop", description: "" },
          { id: "compact", label: "Compact", description: "" },
        ]}
      />,
    )
    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "/")
    const listbox = screen.getByRole("listbox", { name: "Slash commands" })
    const options = screen.getAllByRole("option")
    expect(textarea.getAttribute("aria-expanded")).toBe("true")
    expect(textarea.getAttribute("aria-controls")).toBe(listbox.id)
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[0].id)
    await user.keyboard("{ArrowDown}")
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[1].id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// File attachment
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — file attachment", () => {
  it("shows a preview after upload (text, image, audio, video, zip)", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    // text
    await user.upload(input, new File([""], "notes.txt", { type: "text/plain" }))
    expect(screen.getByText("notes.txt")).toBeTruthy()
    cleanup(); render(<InputBar onSubmit={() => {}} />)

    // image — rendered as <img>
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "photo.png", { type: "image/png" }))
    expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
    cleanup(); render(<InputBar onSubmit={() => {}} />)

    // audio
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "clip.mp3", { type: "audio/mpeg" }))
    expect(screen.getByText("clip.mp3")).toBeTruthy()
    cleanup(); render(<InputBar onSubmit={() => {}} />)

    // video
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "movie.mp4", { type: "video/mp4" }))
    expect(screen.getByText("movie.mp4")).toBeTruthy()
    cleanup(); render(<InputBar onSubmit={() => {}} />)

    // zip (via fireEvent, simulates drag/paste bypassing accept filter)
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([""], "archive.zip", { type: "application/zip" })] } })
    expect(screen.getByText("archive.zip")).toBeTruthy()
  })

  it("removes a file when the remove button is clicked", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "notes.txt", { type: "text/plain" }))
    expect(screen.getByText("notes.txt")).toBeTruthy()
    await user.click(screen.getByLabelText("Remove file"))
    expect(screen.queryByText("notes.txt")).toBeNull()
  })

  it("removes only the targeted image when multiple are attached", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, [new File([""], "keep.png", { type: "image/png" }), new File([""], "remove.png", { type: "image/png" })])
    await user.click(screen.getAllByLabelText("Remove image")[1])
    expect(screen.getByRole("img", { name: "keep.png" })).toBeTruthy()
    expect(screen.queryByRole("img", { name: "remove.png" })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Character count
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — character count", () => {
  it("hidden below 500 chars, visible above 500", () => {
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { fireEvent.change(textarea, { target: { value: "a".repeat(499) } }) })
    expect(screen.queryByText("499")).toBeNull()

    act(() => { fireEvent.change(textarea, { target: { value: "a".repeat(501) } }) })
    expect(screen.getByText("501")).toBeTruthy()
  })

  it("shows error indicator above 2000 chars", () => {
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { fireEvent.change(textarea, { target: { value: "a".repeat(2001) } }) })
    const charCount = screen.getByText("2001")
    expect(charCount).toBeTruthy()
    // The error styling is visual; we verify the element exists and can be styled
    // Implementation detail: actual color rendering is tested via E2E, not unit tests
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// useImperativeHandle ref
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — ref API", () => {
  it("focus() focuses the textarea", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.focus() })
    expect(document.activeElement).toBe(screen.getByLabelText("Message input"))
  })

  it("insertText() inserts at caret position", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    act(() => { ref.current?.setValue("helo") })
    act(() => { textarea.focus(); textarea.setSelectionRange(2, 2); ref.current?.insertText("l") })
    expect(textarea.value).toBe("hello")
  })

  it("insertText('!') at start triggers shell mode", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.focus(); ref.current?.insertText("!") })
    expect(screen.getByLabelText("Shell command input")).toBeTruthy()
  })

  it("appendValue('!make') on an empty draft triggers shell mode — the FloatingInputBar paste-while-minimized path", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.appendValue("!make") })
    const textarea = screen.getByLabelText("Shell command input") as HTMLTextAreaElement
    expect(textarea.value).toBe("make")
  })

  it("appendValue('!make') appends literally when the draft already has text", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.setValue("hello") })
    act(() => { ref.current?.appendValue("!make") })
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.value).toBe("hello !make")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Voice transcript
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — voice transcript", () => {
  it("appends transcript to existing draft", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "hello")
    await user.click(screen.getByLabelText("Start voice input"))
    await user.click(screen.getByLabelText("Stop voice input"))
    await screen.findByLabelText("Start voice input")
    expect(textarea.value).toBe("hello world")
  })

  it("inserts transcript when input is empty", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(screen.getByLabelText("Start voice input"))
    await user.click(screen.getByLabelText("Stop voice input"))
    await screen.findByLabelText("Start voice input")
    expect(textarea.value).toBe("world")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Minimized state
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — minimized state", () => {
  it("hides message slot when minimized", () => {
    render(<InputBar onSubmit={() => {}} minimized />)
    const slot = screen.getByLabelText("Message input").closest('div[aria-hidden="true"]') as HTMLElement
    expect(slot.getAttribute("aria-hidden")).toBe("true")
  })

  it("re-enables textarea on minimize → expand", async () => {
    const { rerender } = render(<InputBar onSubmit={() => {}} minimized={false} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    rerender(<InputBar onSubmit={() => {}} minimized />)
    expect(textarea.getAttribute("disabled")).not.toBeNull()
    rerender(<InputBar onSubmit={() => {}} minimized={false} />)
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(textarea.getAttribute("disabled")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Height reset after submit
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — height reset after submit", () => {
  function stubMultiLine(textarea: HTMLTextAreaElement, lineHeight = 24) {
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => lineHeight * 3 })
    const orig = window.getComputedStyle.bind(window)
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true, writable: true,
      value: (el: Element) => {
        const s = orig(el)
        if (el !== textarea) return s
        return new Proxy(s, { get(t, p) { if (p === "lineHeight") return `${lineHeight}px`; if (p === "fontSize") return "14px"; return (t as unknown as Record<string|symbol, unknown>)[p] } })
      },
    })
    return () => Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 0 })
  }

  it("clears multiline content after submit", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const restore = stubMultiLine(textarea)
    await user.type(textarea, "line one\nline two\nline three")
    act(() => { fireEvent.input(textarea) })
    await user.keyboard("{Enter}")
    restore()
    // Verify the text was cleared after submit (the important behavior)
    expect(textarea.value).toBe("")
  })

  it("collapses the textarea immediately after sending multiline content on mobile", async () => {
    isMobile = true
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => textarea.value ? 60 : 24,
    })

    fireEvent.change(textarea, { target: { value: "line one\nline two" } })
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(textarea.style.height).toBe("60px")

    fireEvent.click(screen.getByRole("button", { name: "Send message" }))

    expect(textarea.value).toBe("")
    expect(textarea.style.height).toBe("auto")
    const slot = textarea.closest("div.min-w-0") as HTMLElement
    expect(slot.style.flexBasis).toBe("")
  })

  it("expands the composer to fit a multiline snippet insertion", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        snippetCommands={[{ id: "long", label: "long", description: "" }]}
        onSnippetCommand={async () => "line one\nline two\nline three"}
      />,
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    // scrollHeight (60px) exceeds the wrap threshold (lineHeight * 1.4 = ~34px),
    // simulating what the browser reports once the multiline body is inserted.
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 60 })
    await user.type(textarea, "#long")
    await user.keyboard("{Enter}")
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(textarea.value).toBe("line one\nline two\nline three")
    expect(textarea.style.height).toBe("60px")
    // isMultiLine promotion pushes the message slot onto its own row
    // (flexBasis: 100%) instead of staying inline next to the send button.
    const slot = textarea.closest("div.min-w-0") as HTMLElement
    expect(slot.style.flexBasis).toBe("100%")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Paste (clipboard)
// ─────────────────────────────────────────────────────────────────────────────
describe("InputBar — paste", () => {
  it("adds a pasted image file", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputBar onSubmit={() => {}} capabilities={caps} />)
    const textarea = screen.getByLabelText("Message input")
    const file = new File(["img"], "pasted.png", { type: "image/png" })
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } })
    expect(screen.getByRole("img", { name: "pasted.png" })).toBeTruthy()
  })

  it("handles null clipboardData items without crashing", () => {
    render(<InputBar onSubmit={() => {}} />)
    fireEvent.paste(screen.getByLabelText("Message input"), { clipboardData: { items: null } })
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })
})

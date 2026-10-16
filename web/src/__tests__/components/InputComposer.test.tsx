import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { InputComposer } from "@/components/InputComposer"
import type { InputComposerHandle } from "@/components/InputComposer"
import { composeWithDesignFeedback, type DesignFeedback } from "@/lib/design-feedback"
import { buildAcceptString, isFileTypeAllowed } from "@/components/InputComposer.files"
import {
  buildHistoryEntries,
  filterMentions,
  filterSlashCommands,
  filterSnippetCommands,
} from "@/components/InputComposer.menus"
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

beforeEach(() => {
  isMobile = false
})

afterEach(cleanup)

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (no DOM) — fast sanity checks on exported helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — pure logic helpers", () => {
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
    for (const ext of [".jsonl", ".astro", ".svelte", ".vue", ".lua", ".prisma"]) {
      expect(accept.split(",")).toContain(ext)
    }
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// Submit behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — submit", () => {
  it("calls onSubmit with trimmed text on Enter", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(<InputComposer onSubmit={(t) => { submitted = t }} />)
    await user.type(screen.getByLabelText("Message input"), "  hello world  ")
    await user.keyboard("{Enter}")
    expect(submitted).toBe("hello world")
  })

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup()
    let count = 0
    render(<InputComposer onSubmit={() => { count++ }} />)
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
    render(<InputComposer onSubmit={() => { count++ }} />)
    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "line1")
    await user.keyboard("{Enter}")
    expect(count).toBe(0)
  })

  it("does not submit when empty or whitespace-only", async () => {
    const user = userEvent.setup()
    let count = 0
    render(<InputComposer onSubmit={() => { count++ }} />)
    const textarea = screen.getByLabelText("Message input")
    await user.keyboard("{Enter}")
    await user.type(textarea, "   ")
    await user.keyboard("{Enter}")
    expect(count).toBe(0)
  })

  it("submits a queued follow-up while streaming", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(<InputComposer onSubmit={(t) => { submitted = t }} isStreaming={true} />)
    await user.type(screen.getByLabelText("Message input"), "follow-up")
    await user.keyboard("{Enter}")
    expect(submitted).toBe("follow-up")
  })

  it("clears input and files after submit", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
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
    render(<InputComposer onSubmit={(_msg, files) => { capturedFiles = files }} />)
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
describe("InputComposer — placeholder and disabled state", () => {
  it("uses the custom placeholder", () => {
    render(<InputComposer onSubmit={() => {}} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toBe("Ask anything…")
  })

  it("overrides placeholder with waiting message when disabled", () => {
    render(<InputComposer onSubmit={() => {}} disabled={true} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toBe("Waiting for response…")
  })

  it("overrides placeholder when streaming", () => {
    render(<InputComposer onSubmit={() => {}} isStreaming={true} placeholder="Ask anything…" />)
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).placeholder).toBe("Steer or queue a follow-up…")
  })

  it("send button disabled with no text, enabled once text is typed", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    const btn = screen.getByLabelText("Send message")
    expect(btn.hasAttribute("disabled")).toBe(true)
    await user.type(screen.getByLabelText("Message input"), "hi")
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("does not render a tooltip on hover over the send button", async () => {
    render(<InputComposer onSubmit={() => {}} />)
    await userEvent.hover(screen.getByLabelText("Send message"))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Input history
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — input history", () => {
  it("navigates local history with arrow keys from an empty input", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
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
    render(<InputComposer onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "previous")
    await user.keyboard("{Enter}")
    await user.type(textarea, "draft")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("draft")
  })

  it("navigates supplied historyPrompts", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} historyPrompts={["newer", "older"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("newer")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("older")
    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("newer")
  })

  it("reports each recalled prompt, and the return to an empty draft", async () => {
    const user = userEvent.setup()
    const onHistoryRecall = mock((..._args: unknown[]) => {})
    render(<InputComposer onSubmit={() => {}} historyPrompts={["newer", "older"]} onHistoryRecall={onHistoryRecall} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)

    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowDown}{ArrowDown}")

    // The third ↑ is past the oldest prompt and recalls nothing new.
    expect(onHistoryRecall.mock.calls.map((call) => call[0])).toEqual(["newer", "older", "newer", null])
  })

  it("does not hijack modified arrow keys", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} historyPrompts={["persisted"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(textarea)
    await user.keyboard("{Control>}{ArrowUp}{/Control}")
    expect(textarea.value).toBe("")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("persisted")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — slash commands", () => {
  it("executes matched slash command on Enter instead of submitting", async () => {
    const user = userEvent.setup()
    let submitCount = 0
    let slashCommand = ""
    render(
      <InputComposer
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
      <InputComposer
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
describe("InputComposer — file attachment", () => {
  it("shows a preview after upload (text, image, audio, video, zip)", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    // text
    await user.upload(input, new File([""], "notes.txt", { type: "text/plain" }))
    expect(screen.getByText("notes.txt")).toBeTruthy()
    cleanup(); render(<InputComposer onSubmit={() => {}} />)

    // image — rendered as <img>
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "photo.png", { type: "image/png" }))
    expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
    cleanup(); render(<InputComposer onSubmit={() => {}} />)

    // audio
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "clip.mp3", { type: "audio/mpeg" }))
    expect(screen.getByText("clip.mp3")).toBeTruthy()
    cleanup(); render(<InputComposer onSubmit={() => {}} />)

    // video
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "movie.mp4", { type: "video/mp4" }))
    expect(screen.getByText("movie.mp4")).toBeTruthy()
    cleanup(); render(<InputComposer onSubmit={() => {}} />)

    // zip (via fireEvent, simulates drag/paste bypassing accept filter)
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([""], "archive.zip", { type: "application/zip" })] } })
    expect(screen.getByText("archive.zip")).toBeTruthy()
  })

  it("removes a file when the remove button is clicked", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File([""], "notes.txt", { type: "text/plain" }))
    expect(screen.getByText("notes.txt")).toBeTruthy()
    await user.click(screen.getByLabelText("Remove file"))
    expect(screen.queryByText("notes.txt")).toBeNull()
  })

  it("removes only the targeted image when multiple are attached", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, [new File([""], "keep.png", { type: "image/png" }), new File([""], "remove.png", { type: "image/png" })])
    await user.click(screen.getAllByLabelText("Remove image")[1])
    expect(screen.getByRole("img", { name: "keep.png" })).toBeTruthy()
    expect(screen.queryByRole("img", { name: "remove.png" })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// No character count
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — long drafts", () => {
  it("does not count characters: messages have no length limit", () => {
    render(<InputComposer onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { fireEvent.change(textarea, { target: { value: "a".repeat(2001) } }) })
    expect(screen.queryByText("2001")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Send / Stop slot (DESIGN.md `button-send`)
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — send and stop buttons", () => {
  it("fills Send with the inverted send pill once there is text", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    await user.type(screen.getByLabelText("Message input"), "hi")

    const send = screen.getByLabelText("Send message")
    expect(send.className).toContain("rounded-full")
    expect(send.className).toContain("bg-(--bg-send)")
  })

  it("draws Stop as the same neutral pill, not an error", () => {
    render(<InputComposer onSubmit={() => {}} isStreaming onStop={() => {}} />)

    const stop = screen.getByLabelText("Stop generation")
    expect(stop.className).toContain("rounded-full")
    expect(stop.className).toContain("bg-(--bg-send)")
    expect(stop.className).not.toContain("--color-error")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// useImperativeHandle ref
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — ref API", () => {
  it("focus() focuses the textarea", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.focus() })
    expect(document.activeElement).toBe(screen.getByLabelText("Message input"))
  })

  it("insertText() inserts at caret position", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    act(() => { ref.current?.setValue("helo") })
    act(() => { textarea.focus(); textarea.setSelectionRange(2, 2); ref.current?.insertText("l") })
    expect(textarea.value).toBe("hello")
  })

  it("appendValue('!make') on an empty draft appends the text literally", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.appendValue("!make") })
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.value).toBe("!make")
  })

  it("appendValue('!make') appends literally when the draft already has text", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    act(() => { ref.current?.setValue("hello") })
    act(() => { ref.current?.appendValue("!make") })
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    expect(textarea.value).toBe("hello !make")
  })

  it("appendValue with paragraph: true starts a new paragraph after existing text", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { ref.current?.appendValue("first", { paragraph: true }) })
    expect(textarea.value).toBe("first")

    act(() => { ref.current?.appendValue("second", { paragraph: true }) })
    expect(textarea.value).toBe("first\n\nsecond")
  })

  it("appendValue with mentions registers them so they are submitted with the message", () => {
    const ref = createRef<InputComposerHandle>()
    const onSubmit = mock((..._args: unknown[]) => {})
    render(<InputComposer onSubmit={onSubmit} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { ref.current?.appendValue("Fix @src/App.tsx#L42 please", { mentions: ["src/App.tsx#L42", "src/Missing.tsx"] }) })
    fireEvent.keyDown(textarea, { key: "Enter" })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    // Only mentions whose token is in the text survive.
    expect(onSubmit.mock.calls[0][2]).toEqual(["src/App.tsx#L42"])
  })
})

describe("InputComposer — design feedback chips", () => {
  const feedback: DesignFeedback = {
    where: "http://localhost:5173/pricing",
    device: "Desktop 1440×900",
    items: [{ n: 1, element: "<button.cta>", text: "Start free", selector: "main > button.cta", source: "@src/Pricing.tsx#L42-L71", html: "<button class=\"cta\">", styles: "", page: null, comment: "Make this larger" }],
  }

  it("shows attached feedback as a chip and sends it after the typed text, with its mentions", () => {
    const ref = createRef<InputComposerHandle>()
    const onSubmit = mock((..._args: unknown[]) => {})
    render(<InputComposer onSubmit={onSubmit} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => { ref.current?.addDesignFeedback(feedback) })
    expect(screen.getByText("Design feedback · 1 comment")).toBeTruthy()
    expect(textarea.value).toBe("")
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(textarea, { target: { value: "Please fix" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [message, , mentions] = onSubmit.mock.calls[0] as [string, unknown, string[]]
    expect(message).toBe(composeWithDesignFeedback("Please fix", [feedback]))
    expect(mentions).toEqual(["src/Pricing.tsx#L42-L71"])
    expect(screen.queryByText("Design feedback · 1 comment")).toBeNull()
  })

  it("sends feedback alone, and can remove it", () => {
    const ref = createRef<InputComposerHandle>()
    const onSubmit = mock((..._args: unknown[]) => {})
    const onDesignFeedbackRemoved = mock((..._args: unknown[]) => {})
    render(<InputComposer onSubmit={onSubmit} ref={ref} onDesignFeedbackRemoved={onDesignFeedbackRemoved} />)
    act(() => { ref.current?.addDesignFeedback(feedback) })
    const other = { ...feedback, where: "http://localhost:5173/about" }
    act(() => { ref.current?.addDesignFeedback(other) })
    fireEvent.click(screen.getAllByRole("button", { name: "Remove design feedback" })[0])
    expect(screen.getAllByText("Design feedback · 1 comment")).toHaveLength(1)
    // The removed feedback goes back to its Preview tab rather than away.
    expect(onDesignFeedbackRemoved.mock.calls).toEqual([[feedback]])
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" })
    expect(onSubmit.mock.calls[0][0]).toBe(composeWithDesignFeedback("", [other]))
  })

  it("turns blocks in restored text back into chips", () => {
    const ref = createRef<InputComposerHandle>()
    render(<InputComposer onSubmit={() => {}} ref={ref} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    act(() => { ref.current?.setValue(composeWithDesignFeedback("Undone text", [feedback])) })
    expect(textarea.value).toBe("Undone text")
    expect(screen.getByText("Design feedback · 1 comment")).toBeTruthy()
    act(() => { ref.current?.setValue("") })
    expect(screen.queryByText("Design feedback · 1 comment")).toBeNull()
    act(() => { ref.current?.appendValue(composeWithDesignFeedback("held", [feedback]), { paragraph: true }) })
    expect(textarea.value).toBe("held")
    expect(screen.getByText("Design feedback · 1 comment")).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Interaction mode
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — interaction mode", () => {
  it("shows the mode control only while expanded", () => {
    const onInteractionModeChange = mock(() => {})
    const { rerender } = render(
      <InputComposer
        minimized
        interactionMode="code"
        onInteractionModeChange={onInteractionModeChange}
        onSubmit={() => {}}
      />,
    )

    expect(screen.queryByRole("button", { name: "Code mode" })).toBeNull()

    rerender(
      <InputComposer
        minimized={false}
        interactionMode="code"
        onInteractionModeChange={onInteractionModeChange}
        onSubmit={() => {}}
      />,
    )

    expect(screen.getByRole("button", { name: "Code mode" })).toBeTruthy()
  })

  it("switches modes with Tab when empty and when containing a draft", async () => {
    const user = userEvent.setup()
    const onInteractionModeChange = mock(() => {})
    render(
      <InputComposer
        interactionMode="code"
        onInteractionModeChange={onInteractionModeChange}
        onSubmit={() => {}}
      />,
    )

    const textarea = screen.getByLabelText("Message input")
    await user.click(textarea)
    await user.keyboard("{Tab}")
    expect(onInteractionModeChange).toHaveBeenCalledWith("plan")

    await user.type(textarea, "Keep this draft")
    await user.keyboard("{Tab}")
    expect(onInteractionModeChange).toHaveBeenCalledTimes(2)
    expect((textarea as HTMLTextAreaElement).value).toBe("Keep this draft")
  })

  it("does not switch modes on Tab when interactionModeDisabled is true", async () => {
    const user = userEvent.setup()
    const onInteractionModeChange = mock(() => {})
    render(
      <InputComposer
        interactionMode="code"
        interactionModeDisabled
        onInteractionModeChange={onInteractionModeChange}
        onSubmit={() => {}}
      />,
    )

    const textarea = screen.getByLabelText("Message input")
    await user.click(textarea)
    await user.type(textarea, "Draft message")
    await user.keyboard("{Tab}")
    expect(onInteractionModeChange).not.toHaveBeenCalled()
  })

  it("does not switch modes on Shift+Tab", async () => {
    const user = userEvent.setup()
    const onInteractionModeChange = mock(() => {})
    render(
      <InputComposer
        interactionMode="code"
        onInteractionModeChange={onInteractionModeChange}
        onSubmit={() => {}}
      />,
    )

    const textarea = screen.getByLabelText("Message input")
    await user.click(textarea)
    await user.type(textarea, "Draft message")
    await user.keyboard("{Shift>}{Tab}{/Shift}")
    expect(onInteractionModeChange).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Minimized state
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — minimized state", () => {
  it("hides message slot when minimized", () => {
    render(<InputComposer onSubmit={() => {}} minimized />)
    const slot = screen.getByLabelText("Message input").closest('div[aria-hidden="true"]') as HTMLElement
    expect(slot.getAttribute("aria-hidden")).toBe("true")
  })

  it("re-enables textarea on minimize → expand", async () => {
    const { rerender } = render(<InputComposer onSubmit={() => {}} minimized={false} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    rerender(<InputComposer onSubmit={() => {}} minimized />)
    expect(textarea.getAttribute("disabled")).not.toBeNull()
    rerender(<InputComposer onSubmit={() => {}} minimized={false} />)
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(textarea.getAttribute("disabled")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Height reset after submit
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — height reset after submit", () => {
  function stubScrollHeight(textarea: HTMLTextAreaElement, height: number) {
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => height })
    return () => Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 0 })
  }

  it("clears multiline content after submit", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const restore = stubScrollHeight(textarea, 72)
    await user.type(textarea, "line one\nline two\nline three")
    act(() => { fireEvent.input(textarea) })
    await user.keyboard("{Enter}")
    restore()
    // Verify the text was cleared after submit (the important behavior)
    expect(textarea.value).toBe("")
  })

  it("collapses the textarea immediately after sending multiline content on mobile", async () => {
    isMobile = true
    render(<InputComposer onSubmit={() => {}} />)
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
    // Expanded always renders the textarea on its own full-width row —
    // clearing the content resets height, not the (static) row layout.
    const slot = textarea.closest("div.min-w-0") as HTMLElement
    expect(slot.style.flexBasis).toBe("100%")
  })

  it("expands the composer to fit a multiline snippet insertion", async () => {
    const user = userEvent.setup()
    render(
      <InputComposer
        onSubmit={() => {}}
        snippetCommands={[{ id: "long", label: "long", description: "" }]}
        onSnippetCommand={async () => "line one\nline two\nline three"}
      />,
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    // Simulates what the browser reports once the multiline body is inserted.
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 60 })
    await user.type(textarea, "#long")
    await user.keyboard("{Enter}")
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(textarea.value).toBe("line one\nline two\nline three")
    expect(textarea.style.height).toBe("60px")
    // Expanded always renders the message slot on its own row (flexBasis:
    // 100%), independent of content — this just guards that invariant.
    const slot = textarea.closest("div.min-w-0") as HTMLElement
    expect(slot.style.flexBasis).toBe("100%")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Paste (clipboard)
// ─────────────────────────────────────────────────────────────────────────────
describe("InputComposer — paste", () => {
  it("adds a pasted image file", () => {
    const caps: AgentCapabilities = { input: { vision: true, document_text: false, audio: false, video: false }, output: { text: true, image: false, audio: false } }
    render(<InputComposer onSubmit={() => {}} capabilities={caps} />)
    const textarea = screen.getByLabelText("Message input")
    const file = new File(["img"], "pasted.png", { type: "image/png" })
    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } })
    expect(screen.getByRole("img", { name: "pasted.png" })).toBeTruthy()
  })

  it("handles null clipboardData items without crashing", () => {
    render(<InputComposer onSubmit={() => {}} />)
    fireEvent.paste(screen.getByLabelText("Message input"), { clipboardData: { items: null } })
    expect(screen.getByLabelText("Message input")).toBeTruthy()
  })
})

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

beforeEach(() => {
  isMobile = false
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
    },
    configurable: true,
  })
  Object.defineProperty(window, "SpeechRecognition", {
    value: MockSpeechRecognition,
    configurable: true,
    writable: true,
  })
})

afterEach(cleanup)

afterEach(() => {
  delete (window as Window & { SpeechRecognition?: unknown }).SpeechRecognition
  Object.defineProperty(navigator, "mediaDevices", {
    value: undefined,
    configurable: true,
  })
})

describe("InputBar", () => {
  it("exports history dedupe logic used by the component", () => {
    expect(buildHistoryEntries([" local ", "other"], ["other", "", " persisted "])).toEqual([
      "local",
      "other",
      "persisted",
    ])
  })

  it("exports slash filtering logic used by the component", () => {
    const commands = [
      { id: "group", label: "Group", description: "", isSeparator: true },
      { id: "continue", label: "Continue", description: "Continue the run" },
      { id: "compact", label: "Compact", description: "Compact session" },
    ]
    expect(filterSlashCommands(commands, "cont").map((cmd) => cmd.id)).toEqual([
      "group",
      "continue",
    ])
  })

  it("exports snippet and mention filtering logic used by the component", () => {
    expect(
      filterSnippetCommands(
        [
          { id: "fix", label: "Fix bug", description: "" },
          { id: "feat", label: "Add feature", description: "" },
        ],
        { start: 0, end: 3, query: "fi" },
      ).map((cmd) => cmd.id),
    ).toEqual(["fix"])

    expect(
      filterMentions(
        [
          { path: "src/app.ts", name: "app.ts", type: "file" },
          { path: "docs/guide.md", name: "guide.md", type: "file" },
        ],
        { start: 0, end: 4, query: "app" },
      ).map((ref) => ref.path),
    ).toEqual(["src/app.ts"])
  })

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

  it("does not submit on Enter on mobile (allows newline)", async () => {
    isMobile = true
    const user = userEvent.setup()
    let submitCount = 0
    const onSubmit = () => {
      submitCount++
    }

    render(<InputBar onSubmit={onSubmit} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "line1")
    await user.keyboard("{Enter}")

    expect(submitCount).toBe(0)
    expect(textarea.value).toContain("\n")
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

  it("navigates submitted input history with arrow keys from an empty input", async () => {
    const user = userEvent.setup()
    const submitted: string[] = []
    render(<InputBar onSubmit={(text) => submitted.push(text)} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "first")
    await user.keyboard("{Enter}")
    await user.type(textarea, "second")
    await user.keyboard("{Enter}")

    expect(submitted).toEqual(["first", "second"])
    expect(textarea.value).toBe("")

    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("second")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("first")

    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("second")

    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("")
  })

  it("does not enter input history when the user has typed a draft", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "previous")
    await user.keyboard("{Enter}")
    await user.type(textarea, "draft")
    await user.keyboard("{ArrowUp}")

    expect(textarea.value).toBe("draft")
  })

  it("navigates supplied chat history prompts before any local submit", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} historyPrompts={["newer persisted", "older persisted"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.click(textarea)
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("newer persisted")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("older persisted")

    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("newer persisted")

    await user.keyboard("{ArrowDown}")
    expect(textarea.value).toBe("")
  })

  it("keeps local submissions ahead of supplied chat history and deduplicates", async () => {
    const user = userEvent.setup()
    const submitted: string[] = []
    render(<InputBar onSubmit={(text) => submitted.push(text)} historyPrompts={["persisted", "local"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "local")
    await user.keyboard("{Enter}")
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("local")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("persisted")
    expect(submitted).toEqual(["local"])
  })

  it("ignores blank history prompts and trims supplied entries", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} historyPrompts={["   ", "  trimmed persisted  ", "\n"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.click(textarea)
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("trimmed persisted")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("trimmed persisted")
  })

  it("does not hijack modified arrow keys for history navigation", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} historyPrompts={["persisted"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.click(textarea)
    await user.keyboard("{Control>}{ArrowUp}{/Control}")
    expect(textarea.value).toBe("")

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}")
    expect(textarea.value).toBe("")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("persisted")
  })

  it("updates navigable history when supplied chat prompts change", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<InputBar onSubmit={() => {}} historyPrompts={["initial"]} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    rerender(<InputBar onSubmit={() => {}} historyPrompts={["latest", "initial"]} />)
    await user.click(textarea)
    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("latest")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("initial")
  })

  it("deduplicates repeated local submissions and does not move past oldest entry", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "same")
    await user.keyboard("{Enter}")
    await user.type(textarea, "same")
    await user.keyboard("{Enter}")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("same")

    await user.keyboard("{ArrowUp}")
    expect(textarea.value).toBe("same")
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
    expect(textarea.placeholder).toMatch(/Queue a follow-up/)
  })

  it("submits a queued follow-up while streaming", async () => {
    const user = userEvent.setup()
    let submittedText = ""
    render(
      <InputBar
        onSubmit={(text) => {
          submittedText = text
        }}
        isStreaming={true}
      />,
    )

    const textarea = screen.getByLabelText("Message input")
    await user.type(textarea, "queued follow-up")
    await user.keyboard("{Enter}")

    expect(submittedText).toBe("queued follow-up")
  })

  it("exposes keyboard shortcuts via send button tooltip", () => {
    const onSubmit = () => {}
    render(<InputBar onSubmit={onSubmit} />)

    const sendButton = screen.getByLabelText("Send message")
    expect(sendButton.getAttribute("title")).toMatch(/Enter/)
    expect(sendButton.getAttribute("title")).toMatch(/Shift\+Enter/)
  })

  it("enters shell mode when bang is typed at the start", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} placeholder="Message the team…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!")

    expect(textarea.value).toBe("")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Enter shell command... git status")
    expect(screen.getByLabelText("Exit shell mode")).toBeTruthy()
    expect(screen.queryByLabelText("Attach file")).toBeNull()
    expect(screen.queryByLabelText(/Voice input/)).toBeNull()
  })

  it("leaves shell mode with Backspace when command is empty", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} placeholder="Message the team…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!")
    await user.keyboard("{Backspace}")

    expect(textarea.value).toBe("")
    expect(screen.getByLabelText("Message input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Message the team…")
    expect(screen.getByLabelText("Use shell mode")).toBeTruthy()
  })

  it("enters and exits shell mode from the shell button", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} placeholder="Message the team…" />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.click(screen.getByLabelText("Use shell mode"))

    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Enter shell command... git status")
    expect(screen.queryByLabelText("Attach file")).toBeNull()

    await user.click(screen.getByLabelText("Exit shell mode"))

    expect(screen.getByLabelText("Message input")).toBe(textarea)
    expect(textarea.placeholder).toBe("Message the team…")
  })

  it("submits shell mode content with a visible bang prefix", async () => {
    const user = userEvent.setup()
    let submittedText = ""
    render(<InputBar onSubmit={(text) => { submittedText = text }} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!pwd")
    await user.keyboard("{Enter}")

    expect(submittedText).toBe("!pwd")
    expect(textarea.value).toBe("")
    expect(screen.getByLabelText("Message input")).toBe(textarea)
  })

  it("does not show slash commands while in shell mode", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[{ id: "stop", label: "Stop", description: "Stop streaming" }]}
      />,
    )

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!/")

    expect(textarea.value).toBe("/")
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull()
  })

  it("restores shell mode when navigating to shell command history", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "!pwd")
    await user.keyboard("{Enter}")
    await user.keyboard("{ArrowUp}")

    expect(textarea.value).toBe("pwd")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
  })

  it("executes the selected slash command when pressing Enter on a partial match", async () => {
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

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "/ne")
    await user.keyboard("{Enter}")

    expect(submitCount).toBe(0)
    expect(slashCommand).toBe("new")
    expect(textarea.value).toBe("")
  })

  it("wires slash command popup to the textarea for screen readers", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[
          { id: "stop", label: "Stop", description: "Stop streaming" },
          { id: "compact", label: "Compact", description: "Compact context" },
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
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{ArrowDown}")
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[1].id)
  })

  it("displays nested commands with colon syntax and inserts colon form", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[
          {
            id: "git/commit",
            label: "git:commit",
            displayName: "git:commit",
            insertText: "git:commit",
            description: "Commit staged changes",
            category: "command",
            keepInputOpen: true,
          },
        ]}
      />,
    )

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "/git")

    expect(screen.getByText("git:")).toBeTruthy()
    expect(screen.getByText("commit")).toBeTruthy()
    expect(screen.queryByText("/git/commit")).toBeNull()

    await user.keyboard("{Enter}")

    expect(textarea.value).toBe("/git:commit ")
  })

  it("inserts snippets from # picker anywhere in the input", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        snippetCommands={[
          { id: "git/commit", label: "git:commit", description: "Commit staged changes" },
          { id: "review", label: "review", description: "Review this change" },
        ]}
        onSnippetCommand={(id) => id === "review" ? "Please review this change" : "Commit prompt"}
      />,
    )

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "start #")

    const listbox = screen.getByRole("listbox", { name: "Snippets" })
    const options = screen.getAllByRole("option")
    expect(textarea.getAttribute("aria-controls")).toBe(listbox.id)
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{ArrowDown}{Enter}")

    expect(textarea.value).toBe("start Please review this change")
  })

  it("opens snippet picker when caret moves into an existing # token", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        snippetCommands={[{ id: "oad", label: "oad", description: "Say hi" }]}
        onSnippetCommand={() => "just say hi"}
      />,
    )

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "hello #oad world")

    expect(screen.queryByRole("listbox", { name: "Snippets" })).toBeNull()

    textarea.setSelectionRange(10, 10)
    fireEvent.select(textarea)

    expect(screen.getByRole("listbox", { name: "Snippets" })).toBeTruthy()
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

    it("strips trailing whitespace from existing draft before appending", async () => {
      const user = userEvent.setup()
      render(<InputBar onSubmit={() => {}} voiceEnabled={true} />)

      const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
      await user.type(textarea, "hello   ")
      await user.click(screen.getByLabelText("Start voice input"))
      await user.click(screen.getByLabelText("Stop voice input"))

      await screen.findByLabelText("Start voice input")
      expect(textarea.value).toBe("hello world")
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage: useImperativeHandle, capabilities, file handling, drag-drop
// ─────────────────────────────────────────────────────────────────────────────

describe("InputBar — useImperativeHandle", () => {
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
    expect(typeof ref.current?.insertText).toBe("function")
  })

  it("inserts text at the current caret position via ref", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    act(() => {
      ref.current?.setValue("helo")
    })
    act(() => {
      textarea.focus()
      textarea.setSelectionRange(2, 2)
      ref.current?.insertText("l")
    })

    expect(textarea.value).toBe("hello")
  })

  it("supports first-key auto-capture after focusing an initially blurred input", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    act(() => {
      ref.current?.focus()
      ref.current?.insertText("h")
    })

    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe("h")
  })

  it("enters shell mode when first-key auto-capture inserts bang", () => {
    const ref = createRef<InputBarHandle>()
    render(<InputBar onSubmit={() => {}} ref={ref} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    act(() => {
      ref.current?.focus()
      ref.current?.insertText("!")
    })

    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe("")
    expect(screen.getByLabelText("Shell command input")).toBe(textarea)
  })
})

describe("InputBar — buildAcceptString (hidden file input accept attribute)", () => {
  it("exports the same accept string logic used by the component", () => {
    const accept = buildAcceptString()
    expect(accept).toContain("text/plain")
    expect(accept).toContain(".md")
    expect(accept).toContain("image/*")
    expect(accept).toContain("application/pdf")
    expect(accept).toContain("audio/*")
    expect(accept).toContain("video/*")
  })

  it("includes all types by default", () => {
    render(<InputBar onSubmit={() => {}} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const accept = input.getAttribute("accept") ?? ""
    expect(accept).toContain("text/plain")
    expect(accept).toContain(".txt")
    expect(accept).toContain("application/json")
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
  it("exports the same file filtering logic used by the component", () => {
    const textFile = new File(["hello"], "notes.txt", { type: "text/plain" })
    const zipFile = new File(["zip"], "archive.zip", { type: "application/zip" })
    const imageFile = new File(["img"], "photo.png", { type: "image/png" })

    expect(isFileTypeAllowed(textFile)).toBe(true)
    expect(isFileTypeAllowed(zipFile)).toBe(false)
    expect(isFileTypeAllowed(imageFile)).toBe(true)
  })

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

  it("allows image files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["img"], "photo.png", { type: "image/png" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    // ImageAttachment renders an img element
    expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
  })

  it("allows PDF files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("report.pdf")).toBeTruthy()
  })

  it("allows DOCX files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["docx"], "doc.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("doc.docx")).toBeTruthy()
  })

  it("allows audio files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["audio"], "clip.mp3", { type: "audio/mpeg" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("clip.mp3")).toBeTruthy()
  })

  it("allows video files", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

    const file = new File(["video"], "movie.mp4", { type: "video/mp4" })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(screen.getByText("movie.mp4")).toBeTruthy()
  })

  it("rejects unknown file types", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} />)

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
    const file = new File(["zip"], "archive.zip", { type: "application/zip" })

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

    expect(screen.queryByText("archive.zip")).toBeNull()
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

describe("InputBar — minimized height and expand reset", () => {
  // Bug: the messageSlot div used opacity-0 to hide the textarea row but
  // still reserved its full height in the flex layout, making the minimized
  // pill taller than just its action buttons.
  it("collapses the message slot to zero height while minimized", () => {
    render(<InputBar onSubmit={() => {}} minimized />)

    // The message slot is the div that wraps the textarea and carries
    // aria-hidden="true" (as opposed to the SVG icons which also use
    // aria-hidden). We find it via its unique combination of being a
    // div with aria-hidden="true" that contains the textarea.
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    // Walk up to the direct wrapper div that carries the aria-hidden + h-0
    const slot = textarea.closest('div[aria-hidden="true"]') as HTMLElement
    expect(slot).toBeTruthy()
    expect(slot.className).toContain("h-0")
    expect(slot.className).toContain("overflow-hidden")
    expect(slot.className).toContain("opacity-0")
  })

  it("reveals the message slot when not minimized", () => {
    render(<InputBar onSubmit={() => {}} minimized={false} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // The slot should NOT carry h-0 when expanded — the textarea must be
    // fully visible and the slot carries opacity-100.
    const slot = textarea.closest('div[aria-hidden]') as HTMLElement
    // aria-hidden is "false" (not "true") when expanded
    expect(slot?.getAttribute("aria-hidden")).toBe("false")
    expect(slot?.className).not.toContain("h-0")
    expect(slot?.className).toContain("opacity-100")

    // The textarea itself must be enabled and interactive
    expect(textarea.getAttribute("disabled")).toBeNull()
    expect(textarea.getAttribute("tabindex")).not.toBe("-1")
  })

  // Bug: isMultiLine state was not reset on minimize → expand, so an empty
  // textarea would re-open in a multi-row layout if it had been multi-line
  // before the bar was minimized.
  it("re-enables the textarea on minimize → expand transition", async () => {
    const { rerender } = render(<InputBar onSubmit={() => {}} minimized={false} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Confirm expanded: enabled + accessible tabindex
    expect(textarea.getAttribute("disabled")).toBeNull()
    expect(textarea.getAttribute("tabindex")).not.toBe("-1")

    // Minimize
    rerender(<InputBar onSubmit={() => {}} minimized />)
    expect(textarea.getAttribute("disabled")).not.toBeNull()

    // Expand again
    rerender(<InputBar onSubmit={() => {}} minimized={false} />)

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    // After expand the textarea must be re-enabled and the slot visible
    expect(textarea.getAttribute("disabled")).toBeNull()
    expect(textarea.getAttribute("tabindex")).not.toBe("-1")

    const slot = textarea.closest('div[aria-hidden]') as HTMLElement
    expect(slot?.getAttribute("aria-hidden")).toBe("false")
    expect(slot?.className).not.toContain("h-0")
  })

  it("does not carry h-0 on the message slot when expanded from the start", () => {
    render(<InputBar onSubmit={() => {}} minimized={false} />)

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    const slot = textarea.closest('div[aria-hidden]') as HTMLElement
    expect(slot?.className).not.toContain("h-0")
  })
})

describe("InputBarSuggestions — dynamic positioning and height clamping", () => {
  it("adjusts position and max-height based on available screen space", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[{ id: "stop", label: "Stop", description: "Stop streaming" }]}
      />,
    )

    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement
    await user.type(textarea, "/")

    const listbox = screen.getByRole("listbox", { name: "Slash commands" })
    expect(listbox).toBeTruthy()

    // The listbox is wrapped in the "contents" div (listbox.parentElement).
    // The parent of that is the "relative" wrapper (listbox.parentElement.parentElement).
    const parent = listbox.parentElement?.parentElement
    expect(parent).toBeTruthy()

    // Scenario 1: Input bar is near the top of the screen (e.g. top = 50px, bottom = 100px).
    // Viewport height is 800px.
    // Space above: 50px. Space below: 800 - 100 = 700px.
    // It should render below (top-full mt-1) with maxHeight = min(256, 700 - 12) = 256px.
    parent!.getBoundingClientRect = () => ({
      top: 50,
      bottom: 100,
      left: 0,
      right: 500,
      width: 500,
      height: 50,
    } as unknown as DOMRect)

    // Set innerHeight to 800
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 })

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      // Wait for resize observer / state updates
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(listbox.className).toContain("top-full")
    expect(listbox.className).toContain("mt-1")
    expect(listbox.className).not.toContain("bottom-full")
    expect(listbox.style.maxHeight).toBe("256px")

    // Scenario 2: Input bar is near the bottom of the screen (e.g. top = 700px, bottom = 750px).
    // Viewport height is 800px.
    // Space above: 700px. Space below: 800 - 750 = 50px.
    // It should render above (bottom-full mb-1) with maxHeight = min(256, 700 - 12) = 256px.
    parent!.getBoundingClientRect = () => ({
      top: 700,
      bottom: 750,
      left: 0,
      right: 500,
      width: 500,
      height: 50,
    } as unknown as DOMRect)

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(listbox.className).toContain("bottom-full")
    expect(listbox.className).toContain("mb-1")
    expect(listbox.className).not.toContain("top-full")
    expect(listbox.style.maxHeight).toBe("256px")

    // Scenario 3: Viewport height is small (e.g. 200px) and input bar is near the bottom.
    // Space above: 120px. Space below: 200 - 170 = 30px.
    // It should render above (bottom-full mb-1) with maxHeight clamped to Math.max(80, 120 - 12) = 108px.
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 200 })
    parent!.getBoundingClientRect = () => ({
      top: 120,
      bottom: 170,
      left: 0,
      right: 500,
      width: 500,
      height: 50,
    } as unknown as DOMRect)

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(listbox.className).toContain("bottom-full")
    expect(listbox.className).toContain("mb-1")
    expect(listbox.style.maxHeight).toBe("108px")

    // Restore window.innerHeight
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: originalInnerHeight })
  })
})

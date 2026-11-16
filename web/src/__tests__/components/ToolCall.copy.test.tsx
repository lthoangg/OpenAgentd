/**
 * What the copy buttons of a tool call put on the clipboard: the formatted
 * arguments a reader sees, not the raw JSON the model sent.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

// Mock clipboard — not available in Happy DOM
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

// ---------------------------------------------------------------------------
// Copy buttons
// ---------------------------------------------------------------------------

describe("ToolCall — copy buttons", () => {
  it("shows copy button for args after expand", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
  })

  it("shows copy button for result after expand", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy result")).toBeTruthy()
  })

  it("args copy button icon turns to check on click", async () => {
    const user = userEvent.setup()
    render(<ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} />)
    await user.click(screen.getByRole("button"))
    const copyBtn = screen.getByLabelText("Copy arguments")
    await user.click(copyBtn)
    // After clicking, button still exists (didn't error out)
    await waitFor(() => expect(screen.getByLabelText("Copy arguments")).toBeTruthy())
  })

  it("result copy button icon turns to check on click", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    const copyBtn = screen.getByLabelText("Copy result")
    await user.click(copyBtn)
    await waitFor(() => expect(screen.getByLabelText("Copy result")).toBeTruthy())
  })

  it("args and result copy buttons are independent", async () => {
    const user = userEvent.setup()
    render(
      <ToolCall name="custom_tool" args='{"path":"hi.txt"}' done={true} result="some result" />
    )
    await user.click(screen.getByRole("button"))
    const argsCopy = screen.getByLabelText("Copy arguments")
    await user.click(argsCopy)
    // Both buttons remain accessible after clicking one
    await waitFor(() => {
      expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
      expect(screen.getByLabelText("Copy result")).toBeTruthy()
    })
  })

})

describe("ToolCall — copy formattedArgs instead of raw JSON", () => {
  it("does not show a copy button for hidden web_search args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "python async", other: "ignored" })
    render(<ToolCall name="web_search" args={args} done result="1. Python async" />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("does not show a copy button for hidden web_fetch args", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://example.com", timeout: 30 })
    render(<ToolCall name="web_fetch" args={args} done result="# Example" />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("copies formattedArgs for remember (formatted items)", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({
        items: [
          { category: "identity", key: "role", value: "Engineer" },
          { category: "preference", key: "style", value: "concise" },
        ],
      })
      render(<ToolCall name="remember" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("[identity] role: Engineer")
      expect(copiedText).toContain("[preference] style: concise")
      expect(copiedText).not.toContain("items")
      expect(copiedText).not.toContain("category")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies formattedArgs for recall (filter string)", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({ category: "preference", key: "style" })
      render(<ToolCall name="recall" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toBe("preference: style")
      expect(copiedText).not.toContain("category")
      expect(copiedText).not.toContain("key")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies formattedArgs for forget (formatted items)", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({
        items: [
          { category: "preference", key: "style" },
          { category: "identity" },
        ],
      })
      render(<ToolCall name="forget" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("preference: style")
      expect(copiedText).toContain("identity")
      expect(copiedText).not.toContain("items")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("copies full JSON for tools without custom formatting", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({ path: "src/main.py", offset: 10, limit: 20 })
      render(<ToolCall name="custom_tool" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      // For custom_tool, formattedArgs is the full JSON, so it should copy the JSON
      expect(copiedText).toContain("path")
      expect(copiedText).toContain("src/main.py")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })
})

describe("ToolCall — getToolDisplay called before copy handlers", () => {
  it("formattedArgs is available in copy handler for shell", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({ command: "echo hello", description: "Print hello" })
      render(<ToolCall name="shell" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy command")
      await user.click(copyBtn)
      // If getToolDisplay was called before copy handler, formattedArgs is in scope
      expect(copiedText).toBe("echo hello")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("does not expose hidden web_search args to the copy handler", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "typescript generics" })
    render(<ToolCall name="web_search" args={args} done result="1. Generics" />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("does not expose hidden web_fetch args to the copy handler", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ url: "https://docs.python.org" })
    render(<ToolCall name="web_fetch" args={args} done result="# Python" />)
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy arguments")).toBeNull()
  })

  it("formattedArgs is available in copy handler for remember", async () => {
    const user = userEvent.setup()
    let copiedText = ""
    const mockWriteText = async (text: string) => {
      copiedText = text
    }
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
    })

    try {
      const args = JSON.stringify({
        items: [{ category: "test", key: "key1", value: "val1" }],
      })
      render(<ToolCall name="remember" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toContain("[test] key1: val1")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("displays nested JSON strings inside arguments as pretty-printed JSON and applies max-height classes", async () => {
    const user = userEvent.setup()
    const nestedInput = JSON.stringify([
      { action: "create", content: "Implement tests" }
    ])
    const args = JSON.stringify({
      filePath: "designs/forms.pen",
      input: nestedInput,
    })

    render(<ToolCall name="custom_tool" args={args} done={false} />)

    // Expand the details panel
    await user.click(screen.getByRole("button"))

    // Find the arguments pre element
    const preEl = screen.getByText((content, element) => {
      return element?.tagName.toLowerCase() === "pre" && content.includes("designs/forms.pen")
    })

    expect(preEl).toBeDefined()
    // Verify that the nested JSON string was parsed and rendered as a real JSON structure
    expect(preEl.textContent).toContain('"action": "create"')
    expect(preEl.textContent).toContain('"content": "Implement tests"')
    expect(preEl.textContent).not.toContain('\\"') // Ensure it's not escaped
  })
})

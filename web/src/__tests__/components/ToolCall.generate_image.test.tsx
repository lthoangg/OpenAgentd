import { describe, it, expect, afterEach, mock } from "bun:test"
import React from "react"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ToolCall } from "@/components/ToolCall"

// Mock framer-motion — cache per-tag so React sees stable component references
const _motionCache: Record<string, React.FC> = {}
const motionProxy = new Proxy({}, {
  get: (_t, tag: string) => {
    if (!_motionCache[tag]) {
      _motionCache[tag] = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(tag, props, children)
    }
    return _motionCache[tag]
  },
})
mock.module("framer-motion", () => ({
  motion: motionProxy,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// The row carries `title="generate_image: <file>.png"` (the real tool name,
// then the target), or just `title="generate_image"` when there is no
// filename. These helpers locate the row via its `title` attribute and assert
// the argument is rendered without italics.

function getHeader(fullText: string): HTMLElement {
  // Linear scan by attribute — Happy DOM rejects some CSS.escape outputs
  const candidates = document.querySelectorAll("[title]")
  for (const node of Array.from(candidates)) {
    if (node instanceof HTMLElement && node.getAttribute("title") === fullText) {
      return node
    }
  }
  throw new Error(`Header with title="${fullText}" not found`)
}

function expectPlainArg(header: HTMLElement, arg: string) {
  expect(header.querySelector("em")).toBeNull()
  expect(header.textContent).toContain(arg)
  expect(header.className).not.toContain("italic")
}

// ---------------------------------------------------------------------------
// generate_image header display
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image header", () => {
  it("shows the plain .png filename after the tool name when filename provided without extension", () => {
    const args = JSON.stringify({ prompt: "a red cube", filename: "red-cube" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: red-cube.png")
    expectPlainArg(header, "red-cube.png")
    expect(header.textContent).not.toContain("Painting")
  })

  it("normalises filename ending in .png (case insensitive) to avoid double extension", () => {
    const args = JSON.stringify({ prompt: "a chart", filename: "chart.PNG" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: chart.png")
    expectPlainArg(header, "chart.png")
    // Ensure no double extension like "chart.PNG.png"
    expect(header.textContent).not.toContain("chart.PNG.png")
  })

  it("normalises filename ending in .png (lowercase) correctly", () => {
    const args = JSON.stringify({ prompt: "a diagram", filename: "diagram.png" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: diagram.png")
    expectPlainArg(header, "diagram.png")
  })

  it("strips any trailing extension before appending .png (matches backend sanitiser)", () => {
    const args = JSON.stringify({ prompt: "a photo", filename: "photo.jpg" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // Backend always saves as PNG regardless of input extension, so the UI
    // must show the true on-disk filename, not ``photo.jpg.png``.
    const header = getHeader("generate_image: photo.png")
    expectPlainArg(header, "photo.png")
    expect(header.textContent).not.toContain("photo.jpg.png")
  })

  it("shows only the tool name, with no target, when filename is omitted", () => {
    const args = JSON.stringify({ prompt: "a cat" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image")
    // No target at all: the row is just the tool name, never a "Painting…" phrase
    expect(header.querySelector("em")).toBeNull()
    expect(header.textContent).not.toContain("Painting")
  })

  it("shows only the tool name, with no target, when filename is empty string", () => {
    const args = JSON.stringify({ prompt: "a cat", filename: "" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows only the tool name, with no target, when filename is whitespace-only", () => {
    const args = JSON.stringify({ prompt: "a cat", filename: "   " })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image")
    expect(header.querySelector("em")).toBeNull()
  })

  it("shows the real tool name in mono next to the filename when args provided", () => {
    const args = JSON.stringify({ prompt: "a cube", filename: "cube" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const name = screen.getByText("generate_image")
    expect(name.className).toContain("font-mono")
    expect(screen.getByText("cube.png")).toBeTruthy()
    expect(screen.queryByText("Generate Image")).toBeNull()
  })

  it("shows the real tool name when args is undefined (pending state)", () => {
    render(<ToolCall name="generate_image" done={false} />)
    expect(screen.getByText("generate_image")).toBeTruthy()
    expect(screen.queryByText("Generate Image")).toBeNull()
  })

  it("does not show a stale pending badge when args is undefined", () => {
    render(<ToolCall name="generate_image" done={false} />)
    expect(screen.queryByText("pending")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// generate_image args display
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image args display", () => {
  it("shows prompt as formatted args when expanded", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a red cube", filename: "cube" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("a red cube")).toBeTruthy()
  })

  it("shows 'arguments' label for args section (not 'bash')", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a cat", filename: "cat" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("arguments")).toBeTruthy()
    expect(screen.queryByText("bash")).toBeNull()
  })

  it("hides args section when prompt is missing", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // Should not be expandable (no args, no result): a plain row, not a button
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(row)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides args section when prompt is empty string", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "", filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(row)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("hides args section when prompt is whitespace-only", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "   ", filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
    await user.click(row)
    expect(screen.queryByText("arguments")).toBeNull()
  })

  it("shows copy button for args when prompt is present", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a dog", filename: "dog" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByLabelText("Copy arguments")).toBeTruthy()
  })

  it("copies only the prompt, not the full JSON", async () => {
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
      const args = JSON.stringify({ prompt: "a beautiful sunset", filename: "sunset" })
      render(<ToolCall name="generate_image" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      const copyBtn = screen.getByLabelText("Copy arguments")
      await user.click(copyBtn)
      expect(copiedText).toBe("a beautiful sunset")
      expect(copiedText).not.toContain("prompt")
      expect(copiedText).not.toContain("filename")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })

  it("lists single input image filename above prompt when images has one entry", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      prompt: "make it red",
      filename: "cube",
      images: ["logo.png"],
    })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    // Blank line separator in whitespace-pre-wrap <pre>; assert on combined text.
    expect(screen.getByText(/images: logo\.png/)).toBeTruthy()
    expect(screen.getByText(/make it red/)).toBeTruthy()
  })

  it("lists comma-joined filenames above prompt when multiple images provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      prompt: "combine these",
      filename: "out",
      images: ["logo.png", "chart.png", "scene.png"],
    })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(
      screen.getByText(/images: logo\.png, chart\.png, scene\.png/),
    ).toBeTruthy()
    expect(screen.getByText(/combine these/)).toBeTruthy()
  })

  it("omits images line when images is an empty array", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      prompt: "a red cube",
      filename: "cube",
      images: [],
    })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("a red cube")).toBeTruthy()
    expect(screen.queryByText(/^images:/)).toBeNull()
  })

  it("ignores empty-string entries in images array", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      prompt: "edit",
      filename: "out",
      images: ["", "logo.png", ""],
    })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(/images: logo\.png/)).toBeTruthy()
  })

  it("copies images line + blank separator + prompt together", async () => {
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
        prompt: "make it red",
        filename: "cube",
        images: ["logo.png", "chart.png"],
      })
      render(<ToolCall name="generate_image" args={args} done={false} />)
      await user.click(screen.getByRole("button"))
      await user.click(screen.getByLabelText("Copy arguments"))
      expect(copiedText).toBe("images: logo.png, chart.png\n\nmake it red")
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: navigator.clipboard,
        writable: true,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// generate_image result suppression
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image result suppression", () => {
  it("suppresses result section even when result is provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a cube", filename: "cube" })
    render(
      <ToolCall
        name="generate_image"
        args={args}
        done={true}
        result="![a cube](cube.png)"
      />
    )
    // Expand to see details
    await user.click(screen.getByRole("button"))
    // Result caption should NOT be in the DOM
    expect(screen.queryByText(/^result$/i)).toBeNull()
    // Arguments section should be visible
    expect(screen.getByText("arguments")).toBeTruthy()
    // Result content should NOT be in the DOM
    expect(screen.queryByText("![a cube](cube.png)")).toBeNull()
  })

  it("shows only arguments section when expanded (no result section)", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a landscape", filename: "landscape" })
    render(
      <ToolCall
        name="generate_image"
        args={args}
        done={true}
        result="![landscape](landscape.png)"
      />
    )
    await user.click(screen.getByRole("button"))
    // Only arguments section should be visible
    expect(screen.getByText("arguments")).toBeTruthy()
    // Result section should not exist
    expect(screen.queryByText("result")).toBeNull()
  })

  it("is still expandable when result is provided (because args are present)", () => {
    const args = JSON.stringify({ prompt: "a tree", filename: "tree" })
    render(
      <ToolCall
        name="generate_image"
        args={args}
        done={true}
        result="![tree](tree.png)"
      />
    )
    // Should be expandable because formattedArgs (prompt) is truthy
    const btn = screen.getByRole("button", { name: "Expand generate_image details" })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })

  it("is not expandable when both args and result are absent", () => {
    const args = JSON.stringify({})
    render(
      <ToolCall
        name="generate_image"
        args={args}
        done={true}
        result="something"
      />
    )
    // No args, result is suppressed → not expandable: a plain row, not a button
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("does not show result copy button when result is suppressed", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a flower", filename: "flower" })
    render(
      <ToolCall
        name="generate_image"
        args={args}
        done={true}
        result="![flower](flower.png)"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.queryByLabelText("Copy result")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// generate_image expand/collapse
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image expand/collapse", () => {
  it("is expandable when prompt is provided", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a mountain", filename: "mountain" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const btn = screen.getByRole("button")
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    await user.click(btn)
    expect(screen.getByText("arguments")).toBeTruthy()
  })

  it("is not expandable when no prompt and no result", () => {
    const args = JSON.stringify({ filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("shows chevron when expandable", () => {
    const args = JSON.stringify({ prompt: "a river", filename: "river" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // When expandable, the row is an interactive disclosure button
    const btn = screen.getByRole("button", { name: "Expand generate_image details" })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })

  it("does not show chevron when not expandable", () => {
    const args = JSON.stringify({ filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // Not expandable: no button, no disclosure state
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(row.hasAttribute("aria-expanded")).toBe(false)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("toggles expanded state on click", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "a sky", filename: "sky" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const btn = screen.getByRole("button")
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    await user.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })
})

// ---------------------------------------------------------------------------
// generate_image status indicators
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image status indicators", () => {
  it("shows start state as just the real tool name when no args", () => {
    render(<ToolCall name="generate_image" done={false} />)
    expect(screen.getByText("generate_image")).toBeTruthy()
    expect(screen.queryByText("Generate Image")).toBeNull()
    expect(screen.queryByText("pending")).toBeNull()
  })

  it("shows running indicator when running (args set, not done)", () => {
    const args = JSON.stringify({ prompt: "a cloud", filename: "cloud" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const btn = screen.getByRole("button")
    // Running is a blue dot plus "running…", not a pulsing label
    expect(btn.querySelector("[data-running-dot]")).toBeTruthy()
    expect(btn.querySelector(".animate-pulse")).toBeNull()
    expect(btn.textContent).toContain("cloud.png")
    expect(btn.textContent).toContain("running…")
  })

  it("shows done indicator when done", () => {
    const args = JSON.stringify({ prompt: "a star", filename: "star" })
    render(<ToolCall name="generate_image" args={args} done={true} />)
    const btn = screen.getByRole("button")
    expect(btn).toBeTruthy()
    // Done state: no pending badge
    expect(screen.queryByText("pending")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// generate_image edge cases
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image edge cases", () => {
  it("handles filename with multiple dots (only strips final .png)", () => {
    const args = JSON.stringify({ prompt: "a file", filename: "my.image.file.png" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: my.image.file.png")
    expectPlainArg(header, "my.image.file.png")
  })

  it("handles filename with multiple dots and no .png extension", () => {
    const args = JSON.stringify({ prompt: "a file", filename: "my.image.file" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // Regex strips only the final trailing extension — ``.file`` is treated
    // as one, so output is ``my.image.png``.
    const header = getHeader("generate_image: my.image.png")
    expectPlainArg(header, "my.image.png")
  })

  it("handles special characters in filename", () => {
    const args = JSON.stringify({ prompt: "a scene", filename: "my-image_v2" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: my-image_v2.png")
    expectPlainArg(header, "my-image_v2.png")
  })

  it("handles special characters in prompt", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ prompt: "A beautiful sunset with colors: red, orange, yellow!", filename: "sunset" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("A beautiful sunset with colors: red, orange, yellow!")).toBeTruthy()
  })

  it("handles very long prompt", async () => {
    const user = userEvent.setup()
    const longPrompt = "A detailed landscape painting showing a mountain range with snow-capped peaks, a crystal clear lake in the foreground, and a sunset sky with vibrant colors"
    const args = JSON.stringify({ prompt: longPrompt, filename: "landscape" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    await user.click(screen.getByRole("button"))
    expect(screen.getByText(longPrompt)).toBeTruthy()
  })

  it("handles extra fields in args (ignored)", () => {
    const args = JSON.stringify({ prompt: "a scene", filename: "scene", model: "dall-e-3", quality: "hd" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image: scene.png")
    expectPlainArg(header, "scene.png")
  })

  it("handles null prompt", () => {
    const args = JSON.stringify({ prompt: null, filename: "foo" })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    // null prompt is treated as missing: nothing to expand, so not a button
    const row = screen.getByLabelText("generate_image (no details)")
    expect(row.tagName).toBe("DIV")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("handles null filename (tool name only)", () => {
    const args = JSON.stringify({ prompt: "a scene", filename: null })
    render(<ToolCall name="generate_image" args={args} done={false} />)
    const header = getHeader("generate_image")
    expect(header.querySelector("em")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// generate_image does not regress other tools
// ---------------------------------------------------------------------------

describe("ToolCall — generate_image does not regress other tools", () => {
  it("shell tool still shows completed output", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ command: "ls", description: "list files" })
    render(
      <ToolCall
        name="shell"
        args={args}
        done={true}
        result="file1\nfile2\nfile3"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("terminal")).toBeTruthy()
    expect(screen.queryByText("result")).toBeNull()
    // Terminal output keeps newlines, so use a regex matcher
    expect(screen.getByText(/file1.*file2.*file3/s)).toBeTruthy()
  })

  it("web_search tool still shows result section", async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({ query: "python asyncio" })
    render(
      <ToolCall
        name="web_search"
        args={args}
        done={true}
        result="Found 1000 results about asyncio"
      />
    )
    await user.click(screen.getByRole("button"))
    expect(screen.queryByText("arguments")).toBeNull()
    expect(screen.getByText("result")).toBeTruthy()
  })
})

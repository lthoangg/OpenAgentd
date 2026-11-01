import { describe, it, expect, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

import { CodeBlock } from "@/components/CodeBlock"

afterEach(cleanup)

describe("CodeBlock", () => {
  it("renders code content inside pre and code tags", () => {
    render(<CodeBlock rawText="console.log('hello')">console.log('hello')</CodeBlock>)
    const pre = screen.getByText("console.log('hello')").closest("pre")
    expect(pre).toBeTruthy()
    expect(pre?.querySelector("code")).toBeTruthy()
  })

  it("renders a bordered rounded-sm card (DESIGN code-block)", () => {
    const { container } = render(
      <CodeBlock language="typescript" rawText="const x = 1">
        const x = 1
      </CodeBlock>,
    )
    const outerDiv = container.firstElementChild as HTMLElement
    expect(outerDiv.className).toContain("border")
    expect(outerDiv.className).toContain("border-(--color-border)")
    expect(outerDiv.className).toContain("rounded-sm")

    const headerDiv = screen.getByText("typescript").closest("div") as HTMLElement
    expect(headerDiv.className).toContain("border-b")
    expect(headerDiv.className).toContain("border-(--color-border)")
    expect(headerDiv.className).not.toContain("rounded")
  })

  it("renders the language tag in the header when language is provided", () => {
    render(
      <CodeBlock language="python" rawText="print(1)">
        print(1)
      </CodeBlock>,
    )
    expect(screen.getByText("python")).toBeTruthy()
  })

  it("renders only pre element when noHeader is true", () => {
    const { container } = render(
      <CodeBlock rawText="plain text" noHeader>
        plain text
      </CodeBlock>,
    )
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe("pre")
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull()
  })

  it("copies rawText to clipboard when copy button is clicked", async () => {
    const writeText = mock(() => Promise.resolve())
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })

    render(
      <CodeBlock language="bash" rawText="echo 'hello world'">
        echo 'hello world'
      </CodeBlock>,
    )

    const copyBtn = screen.getByRole("button", { name: "Copy code" })
    fireEvent.click(copyBtn)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("echo 'hello world'"))
  })

  it("keeps Copy in the header at rest, muted and large enough to hit", () => {
    render(
      <CodeBlock language="bash" rawText="ls">
        ls
      </CodeBlock>,
    )
    const copyBtn = screen.getByRole("button", { name: "Copy code" })
    // In the header beside the language, not floating over the code.
    expect(copyBtn.closest("div")?.textContent).toContain("bash")
    expect(copyBtn.closest("pre")).toBeNull()
    expect(copyBtn.className).toContain("size-6")
    expect(copyBtn.className).toContain("pointer-coarse:size-9")
    expect(copyBtn.className).toContain("text-(--color-text-muted)")
    expect(copyBtn.className).not.toContain("opacity-0")
    expect(copyBtn.className).not.toContain("group-hover")
    // The app tooltip names it; no native title.
    expect(copyBtn.getAttribute("title")).toBeNull()
  })

  it("gives a block with no language the same header, captioned 'text'", () => {
    render(<CodeBlock rawText="plain">plain</CodeBlock>)
    const copyBtn = screen.getByRole("button", { name: "Copy code" })
    expect(copyBtn.closest("div")?.textContent).toContain("text")
    expect(copyBtn.closest("pre")).toBeNull()
  })

  it("says Copied for a moment: a check icon and a note for screen readers", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mock(() => Promise.resolve()) },
      configurable: true,
    })
    render(
      <CodeBlock language="bash" rawText="ls">
        ls
      </CodeBlock>,
    )
    const header = screen.getByRole("button", { name: "Copy code" }).closest("div") as HTMLElement
    expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe("")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })) })
    expect(header.querySelector('[aria-live="polite"]')?.textContent).toBe("Copied")
    expect(screen.getByRole("button", { name: "Copy code" }).querySelector("svg.lucide-check")).toBeTruthy()
  })
})

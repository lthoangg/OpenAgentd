import { describe, it, expect, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

import { CodeBlock } from "@/components/CodeBlock"

afterEach(cleanup)

describe("CodeBlock", () => {
  it("renders code content inside pre and code tags", () => {
    render(<CodeBlock rawText="console.log('hello')">console.log('hello')</CodeBlock>)
    const pre = screen.getByText("console.log('hello')").closest("pre")
    expect(pre).toBeTruthy()
    expect(pre?.querySelector("code")).toBeTruthy()
  })

  it("renders with borders but no roundness on container", () => {
    const { container } = render(
      <CodeBlock language="typescript" rawText="const x = 1">
        const x = 1
      </CodeBlock>,
    )
    const outerDiv = container.firstElementChild as HTMLElement
    expect(outerDiv.className).toContain("border")
    expect(outerDiv.className).toContain("border-(--color-border)")
    expect(outerDiv.className).not.toContain("rounded")

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
})

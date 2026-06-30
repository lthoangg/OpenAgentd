import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { DiffView } from "@/components/ToolCall/DiffView"
import { diffLines } from "@/components/ToolCall/diffUtils"

afterEach(cleanup)

describe("diffLines", () => {
  it("computes line-by-line diff correctly", () => {
    const oldStr = "line1\nline2\nline3"
    const newStr = "line1\nline2 modified\nline3\nline4"
    const result = diffLines(oldStr, newStr)

    expect(result).toEqual([
      { type: "equal", value: "line1" },
      { type: "removed", value: "line2" },
      { type: "added", value: "line2 modified" },
      { type: "equal", value: "line3" },
      { type: "added", value: "line4" },
    ])
  })
})

describe("DiffView", () => {
  it("renders edit tool diff correctly", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: "def hello():\n    print('hello')",
      new_string: "def hello():\n    print('hello world')",
    })

    render(<DiffView toolName="edit" args={args} result={'@@ openagentd-diff-meta {"path":"src/main.py","old_start":42,"new_start":42}'} />)

    expect(screen.getByRole("button", { name: "Collapse diff for src/main.py" })).toBeTruthy()
    expect(screen.getByText("def hello():")).toBeTruthy()
    expect(screen.getByText("print('hello')")).toBeTruthy()
    expect(screen.getByText("print('hello world')")).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it("keeps diff line numbers sticky and inherits row highlight", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: "old line",
      new_string: "new line",
    })

    render(<DiffView toolName="edit" args={args} />)

    const gutterClassName = screen.getAllByText('1')[0].parentElement?.className ?? ''
    expect(gutterClassName).toContain('sticky left-0')
    expect(gutterClassName).toContain('bg-inherit')
  })

  it("does not make the file header sticky", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: "old line",
      new_string: "new line",
    })

    render(<DiffView toolName="edit" args={args} />)

    const headerClassName = screen.getByRole("button", { name: "Collapse diff for src/main.py" }).className
    expect(headerClassName).not.toContain('sticky')
    expect(headerClassName).not.toContain('top-0')
  })

  it("toggles edit diff when no outer collapse handler is provided", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: "old line",
      new_string: "new line",
    })

    render(<DiffView toolName="edit" args={args} />)

    const header = screen.getByRole("button", { name: "Collapse diff for src/main.py" })
    expect(screen.getByText("old line")).toBeTruthy()

    fireEvent.click(header)
    expect(screen.queryByText("old line")).toBeNull()
    expect(screen.getByRole("button", { name: "Expand diff for src/main.py" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Expand diff for src/main.py" }))
    expect(screen.getByText("old line")).toBeTruthy()
  })

  it("calls the outer collapse handler when clicking an expanded edit file header", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: "old line",
      new_string: "new line",
    })
    let collapsed = false

    render(<DiffView toolName="edit" args={args} onCollapse={() => { collapsed = true }} />)

    fireEvent.click(screen.getByRole("button", { name: "Collapse diff for src/main.py" }))

    expect(collapsed).toBe(true)
    expect(screen.getByText("old line")).toBeTruthy()
  })

  it("renders patch tool diff correctly", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n")

    const args = JSON.stringify({ patch_text: patchText })

    render(
      <DiffView
        toolName="patch"
        args={args}
        result={'@@ openagentd-diff-meta {"files":[{"path":"src/utils.py","hunks":[{"old_start":17,"new_start":17}]}]}' }
      />,
    )

    expect(screen.getByRole("button", { name: "Collapse diff for src/utils.py" })).toBeTruthy()
    expect(screen.getByText("old line")).toBeTruthy()
    expect(screen.getByText("new line")).toBeTruthy()
    expect(screen.getAllByText('17')).toHaveLength(2)
  })

  it("toggles patch file diff when no outer collapse handler is provided", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n")

    render(<DiffView toolName="patch" args={JSON.stringify({ patch_text: patchText })} />)

    const header = screen.getByRole("button", { name: "Collapse diff for src/utils.py" })
    expect(screen.getByText("old line")).toBeTruthy()

    fireEvent.click(header)
    expect(screen.queryByText("old line")).toBeNull()
    expect(screen.getByRole("button", { name: "Expand diff for src/utils.py" })).toBeTruthy()
  })

  it("calls the outer collapse handler when clicking an expanded patch file header", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n")
    let collapsed = false

    render(
      <DiffView
        toolName="patch"
        args={JSON.stringify({ patch_text: patchText })}
        onCollapse={() => { collapsed = true }}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Collapse diff for src/utils.py" }))

    expect(collapsed).toBe(true)
    expect(screen.getByText("old line")).toBeTruthy()
  })

  it("toggles one file in a multi-file patch independently", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-old utils line",
      "+new utils line",
      "*** Update File: src/main.py",
      "@@",
      "-old main line",
      "+new main line",
      "*** End Patch",
    ].join("\n")

    render(<DiffView toolName="patch" args={JSON.stringify({ patch_text: patchText })} />)

    const utilsHeader = screen.getByRole("button", { name: "Collapse diff for src/utils.py" })
    expect(screen.getByText("old utils line")).toBeTruthy()
    expect(screen.getByText("old main line")).toBeTruthy()

    fireEvent.click(utilsHeader)
    expect(screen.queryByText("old utils line")).toBeNull()
    expect(screen.getByText("old main line")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Expand diff for src/utils.py" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Collapse diff for src/main.py" })).toBeTruthy()
  })

  it("does not call the outer collapse handler when toggling one file in a multi-file patch", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-old utils line",
      "+new utils line",
      "*** Update File: src/main.py",
      "@@",
      "-old main line",
      "+new main line",
      "*** End Patch",
    ].join("\n")
    let collapsed = false

    render(
      <DiffView
        toolName="patch"
        args={JSON.stringify({ patch_text: patchText })}
        onCollapse={() => { collapsed = true }}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Collapse diff for src/utils.py" }))

    expect(collapsed).toBe(false)
    expect(screen.queryByText("old utils line")).toBeNull()
    expect(screen.getByText("old main line")).toBeTruthy()
  })

  it("renders patch hunks with their own line starts", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.py",
      "@@",
      "-first old",
      "+first new",
      "@@",
      "-second old",
      "+second new",
      "*** End Patch",
    ].join("\n")

    const args = JSON.stringify({ patch_text: patchText })

    render(
      <DiffView
        toolName="patch"
        args={args}
        result={'@@ openagentd-diff-meta {"files":[{"path":"src/utils.py","hunks":[{"old_start":10,"new_start":10},{"old_start":20,"new_start":21}]}]}' }
      />,
    )

    expect(screen.getByText("first old")).toBeTruthy()
    expect(screen.getByText("first new")).toBeTruthy()
    expect(screen.getByText("second old")).toBeTruthy()
    expect(screen.getByText("second new")).toBeTruthy()
    expect(screen.getAllByText('10')).toHaveLength(2)
    expect(screen.getByText('20')).toBeTruthy()
    expect(screen.getByText('21')).toBeTruthy()
  })

  it("renders write tool diff correctly", () => {
    const args = JSON.stringify({
      path: "src/new_file.py",
      content: "print('hello world')",
    })

    render(<DiffView toolName="write" args={args} />)

    expect(screen.getByText("src/new_file.py")).toBeTruthy()
    expect(screen.getByText("print('hello world')")).toBeTruthy()
  })

  it("handles invalid JSON gracefully", () => {
    render(<DiffView toolName="edit" args="invalid json" />)
    expect(screen.getByText("invalid json")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Background bleed regression — inner wrappers must NOT carry their own
// border-radius that creates a pixel gap against the outer overflow-hidden
// section.  Redundant rounded-* classes were the second cause of the bleed.
// ---------------------------------------------------------------------------

describe("DiffView — no redundant inner border-radius (bg-bleed regression)", () => {
  it("SingleFileDiff wrapper has no first:rounded-t-sm / last:rounded-b-sm on outer div", () => {
    const args = JSON.stringify({
      path: "src/foo.ts",
      old_string: "old",
      new_string: "new",
    })
    render(<DiffView toolName="edit" args={args} />)

    // The container holding the diff lines must not carry border-radius that
    // would create a gap against the clipping parent.
    const contentArea = document.querySelector(".overflow-y-auto.bg-\\(--bg-input\\)")
    expect(contentArea).not.toBeNull()
    expect(contentArea!.className).not.toContain("rounded-b-sm")
  })

  it("edit outer DiffView wrapper has no rounded-sm", () => {
    const args = JSON.stringify({
      path: "src/foo.ts",
      old_string: "a",
      new_string: "b",
    })
    render(<DiffView toolName="edit" args={args} />)

    // The immediate child of DiffView (overflow-hidden div) must not add its
    // own rounding — the parent section already clips with overflow:hidden.
    const wrapper = document.querySelector(".overflow-hidden:not(section)")
    // If it exists it must not contain rounded-sm
    if (wrapper) {
      expect(wrapper.className).not.toContain("rounded-sm")
    }
  })

  it("write outer DiffView wrapper has no rounded-sm", () => {
    const args = JSON.stringify({
      path: "src/new.ts",
      content: "export {}",
    })
    render(<DiffView toolName="write" args={args} />)

    const wrapper = document.querySelector(".overflow-hidden:not(section)")
    if (wrapper) {
      expect(wrapper.className).not.toContain("rounded-sm")
    }
  })

  it("patch outer DiffView wrapper has no rounded-sm", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/utils.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    render(<DiffView toolName="patch" args={JSON.stringify({ patch_text: patchText })} />)

    const wrapper = document.querySelector(".overflow-hidden:not(section)")
    if (wrapper) {
      expect(wrapper.className).not.toContain("rounded-sm")
    }
  })
})

describe("DiffView — LSP Diagnostics integration", () => {
  it("renders LSP diagnostics below the diff view when diagnostics exist in the result", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      content: "def foo(",
    })
    const result =
      "Written 8 bytes to src/main.py\n\n[LSP Diagnostics]\n- src/main.py:1:9: error: unexpected EOF while parsing (Ruff)"

    render(<DiffView toolName="write" args={args} result={result} />)

    // Verify diff content is rendered
    expect(screen.getByText("src/main.py")).toBeTruthy()
    expect(screen.getByText("def foo(")).toBeTruthy()

    // Verify LSP diagnostics are rendered (compact label)
    expect(screen.getByText("ERR")).toBeTruthy()
    expect(screen.getByText("1:9")).toBeTruthy()
    expect(screen.getByText("unexpected EOF while parsing")).toBeTruthy()
  })
})

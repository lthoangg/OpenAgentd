import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { DiffView } from "@/components/ToolCall/DiffView"
import { diffLines, MAX_LCS_CELLS } from "@/components/ToolCall/diffUtils"

afterEach(cleanup)

/** The invariants that define a correct line diff. Byte-equality with any
 *  particular implementation is *not* required: when a run of identical lines
 *  makes the insertion point ambiguous several distinct minimal diffs exist. */
function expectValidDiff(oldStr: string, newStr: string) {
  const oldLines = oldStr.replace(/\r\n/g, "\n").split("\n")
  const newLines = newStr.replace(/\r\n/g, "\n").split("\n")
  const out = diffLines(oldStr, newStr)

  // (removed + equal) reconstructs the old side; (added + equal) the new side.
  expect(out.filter((l) => l.type !== "added").map((l) => l.value)).toEqual(oldLines)
  expect(out.filter((l) => l.type !== "removed").map((l) => l.value)).toEqual(newLines)
  return out
}

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

  it("satisfies the reconstruction invariants on edge-case inputs", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["", "a"],
      ["a", ""],
      ["a", "a"],
      ["a\nb\nc", "a\nb\nc"],
      ["a\nb\nc", "c\nb\na"],
      ["a\nb\nc\nd\ne", "a\nX\nc\nY\ne"],
      ["\n", "\n\n"],
      ["\n\n\n", "\n"],
      ["a\n", "a"],
      ["a", "a\n"],
      ["same\nsame\nsame", "same\nsame\nsame\nsame"],
      ["a\r\nb", "a\nb"],
    ]
    for (const [oldStr, newStr] of cases) expectValidDiff(oldStr, newStr)
  })

  it("marks an unchanged file entirely equal (no double-counted prefix/suffix)", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const out = expectValidDiff(text, text)
    expect(out.every((l) => l.type === "equal")).toBe(true)
    expect(out).toHaveLength(20)
  })

  it("stays minimal for a one-line change inside a large file", () => {
    // Prefix/suffix trimming must keep this exact rather than tripping the
    // cell budget: 5000x5000 would be 25M cells without the trim.
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const mutated = [...base]
    mutated[2500] = "line 2500 changed"
    const out = expectValidDiff(base.join("\n"), mutated.join("\n"))
    expect(out.filter((l) => l.type === "removed")).toHaveLength(1)
    expect(out.filter((l) => l.type === "added")).toHaveLength(1)
  })

  it("falls back to a block diff above the LCS cell budget, still reconstructing both sides", () => {
    const n = 1200 // 1200*1200 = 1.44M cells > MAX_LCS_CELLS, nothing in common
    expect(n * n).toBeGreaterThan(MAX_LCS_CELLS)
    const oldLines = Array.from({ length: n }, (_, i) => `old ${i}`)
    const newLines = Array.from({ length: n }, (_, i) => `new ${i}`)
    const out = expectValidDiff(oldLines.join("\n"), newLines.join("\n"))
    expect(out.filter((l) => l.type === "removed")).toHaveLength(n)
    expect(out.filter((l) => l.type === "added")).toHaveLength(n)
  })

  it("handles a large all-different diff without blowing up", () => {
    const mk = (s: string) =>
      Array.from({ length: 3000 }, (_, i) => `line ${i} ${s}`).join("\n")
    const started = Date.now()
    expectValidDiff(mk("a"), mk("b"))
    // The pre-fix quadratic path spent ~60ms and ~69MB here.
    expect(Date.now() - started).toBeLessThan(1000)
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

  it("keeps long diff content vertically scrollable", () => {
    const args = JSON.stringify({
      path: "src/main.py",
      old_string: Array.from({ length: 40 }, (_, i) => `old line ${i}`).join("\n"),
      new_string: Array.from({ length: 40 }, (_, i) => `new line ${i}`).join("\n"),
    })

    render(<DiffView toolName="edit" args={args} />)

    const scrollContainer = screen.getByText("old line 0").closest(".overflow-y-auto")
    expect(scrollContainer).toBeTruthy()
    expect(scrollContainer?.className).toContain("h-full")
    expect(scrollContainer?.className).toContain("touch-pan-y")
    expect(scrollContainer?.className).not.toContain("overscroll-contain")
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
    expect(screen.getByRole("button", { name: "Expand diff for src/main.py" })).toBeTruthy()
    expect(screen.getByText("old line").closest('[aria-hidden="true"]')).toBeTruthy()

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
    expect(screen.getByRole("button", { name: "Expand diff for src/utils.py" })).toBeTruthy()
    expect(screen.getByText("old line").closest('[aria-hidden="true"]')).toBeTruthy()
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
    expect(screen.getByText("old utils line").closest('[aria-hidden="true"]')).toBeTruthy()
    expect(screen.getByText("old main line").closest('[aria-hidden="true"]')).toBeNull()
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
    expect(screen.getByText("old utils line").closest('[aria-hidden="true"]')).toBeTruthy()
    expect(screen.getByText("old main line").closest('[aria-hidden="true"]')).toBeNull()
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

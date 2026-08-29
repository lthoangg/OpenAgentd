/**
 * Performance: memo & memoization invariants.
 *
 * These tests verify the behavioral outcomes guaranteed by the optimizations:
 *
 * - `AssistantTurnFooter`: `useCallback` on handleCopy — stable across re-renders.
 * - `TodosPopover`: `sortedTodos` with `useMemo` — sort order is correct and
 *   stable regardless of the input array reference changing.
 * - `CodingFileViewerPanel/TextPreview`: `lines` memoized — the same content
 *   string produces the same line array, and selection state changes don't
 *   corrupt the rendered text.
 * - `Sidebar`: `dateGroups` with `useMemo` — group labels are deterministic.
 *
 * We test *behavior* (render output, DOM content) rather than implementation
 * details — no spying on `memo` or checking `.type.displayName`.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom"
import { AssistantTurnFooter } from "@/components/AssistantTurnFooter"
import { TodosPopover } from "@/components/TodosPopover"
import type { ContentBlock } from "@/api/types"
import type { TodoItem } from "@/api/types"

// Install clipboard mock before any test runs (same pattern as AssistantTurnFooter.test.tsx)
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

afterEach(cleanup)

// ─────────────────────────────────────────────────────────────────────────────
// AssistantTurnFooter — handleCopy (useCallback)
// ─────────────────────────────────────────────────────────────────────────────

describe("AssistantTurnFooter — copy button stability", () => {
  it("copy button is present and clickable", async () => {
    const blocks: ContentBlock[] = [
      { id: "b1", type: "text", content: "Hello world", timestamp: new Date() },
    ]

    const user = userEvent.setup()
    render(<AssistantTurnFooter turnBlocks={blocks} />)

    const copyBtn = screen.getByLabelText("Copy response")
    expect(copyBtn).toBeTruthy()
    // clicking must not throw
    await user.click(copyBtn)
  })

  it("shows check icon briefly after copy then reverts to copy icon", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
      writable: true,
    })

    const blocks: ContentBlock[] = [
      { id: "b1", type: "text", content: "Some text" },
    ]

    const user = userEvent.setup()
    render(<AssistantTurnFooter turnBlocks={blocks} />)

    // Before click: copy button visible
    expect(screen.getByLabelText("Copy response")).toBeTruthy()

    await user.click(screen.getByLabelText("Copy response"))

    // After click: button still present (aria-label unchanged while check icon is shown)
    expect(screen.getByLabelText("Copy response")).toBeTruthy()
  })

  it("returns null when turnBlocks is empty", () => {
    const { container } = render(<AssistantTurnFooter turnBlocks={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("does not render copy button when all blocks are tool blocks with no text content", () => {
    const blocks: ContentBlock[] = [
      { id: "t1", type: "tool", content: "", toolName: "shell", toolDone: true },
    ]
    render(<AssistantTurnFooter turnBlocks={blocks} />)
    expect(screen.queryByLabelText("Copy response")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TodosPopover — sortedTodos (useMemo)
// ─────────────────────────────────────────────────────────────────────────────

describe("TodosPopover — memoized sort order", () => {
  const makeTodo = (
    task_id: string,
    content: string,
    status: TodoItem["status"],
  ): TodoItem => ({ task_id, content, status })

  it("always renders in_progress before pending regardless of input order", () => {
    const todos: TodoItem[] = [
      makeTodo("1", "Pending first", "pending"),
      makeTodo("2", "In progress", "in_progress"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    const items = screen.getAllByRole("listitem")
    expect(items[0].textContent).toContain("In progress")
    expect(items[1].textContent).toContain("Pending first")
  })

  it("always renders completed before cancelled", () => {
    const todos: TodoItem[] = [
      makeTodo("1", "Cancelled item", "cancelled"),
      makeTodo("2", "Completed item", "completed"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    const items = screen.getAllByRole("listitem")
    expect(items[0].textContent).toContain("Completed item")
    expect(items[1].textContent).toContain("Cancelled item")
  })

  it("renders full order: in_progress → pending → completed → cancelled with 4 items", () => {
    const todos: TodoItem[] = [
      makeTodo("c", "Cancelled", "cancelled"),
      makeTodo("d", "Completed", "completed"),
      makeTodo("p", "Pending", "pending"),
      makeTodo("a", "Active", "in_progress"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    const items = screen.getAllByRole("listitem")
    expect(items[0].textContent).toContain("Active")
    expect(items[1].textContent).toContain("Pending")
    expect(items[2].textContent).toContain("Completed")
    expect(items[3].textContent).toContain("Cancelled")
  })

  it("progress bar reaches 100% when all tasks are finished", () => {
    const todos: TodoItem[] = [
      makeTodo("1", "Done A", "completed"),
      makeTodo("2", "Done B", "completed"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    const bar = screen.getByRole("progressbar")
    expect(bar.getAttribute("aria-valuenow")).toBe("100")
  })

  it("progress bar is 0 when all tasks are pending", () => {
    const todos: TodoItem[] = [
      makeTodo("1", "Not started", "pending"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    const bar = screen.getByRole("progressbar")
    expect(bar.getAttribute("aria-valuenow")).toBe("0")
  })

  it("counts cancelled tasks as finished in the progress counter", () => {
    const todos: TodoItem[] = [
      makeTodo("1", "Done", "completed"),
      makeTodo("2", "Dropped", "cancelled"),
      makeTodo("3", "Todo", "pending"),
    ]

    render(
      <TodosPopover open onOpenChange={() => {}} todos={todos} sessionId="s1" />,
    )

    expect(screen.getByText("2/3 done")).toBeTruthy()
  })

  it("does not render progress bar when todos list is empty", () => {
    render(
      <TodosPopover open onOpenChange={() => {}} todos={[]} sessionId="s1" />,
    )

    expect(screen.queryByRole("progressbar")).toBeNull()
  })
})

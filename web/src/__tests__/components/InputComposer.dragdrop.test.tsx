import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { useRef } from "react"
import { InputComposer, type InputComposerHandle } from "@/components/InputComposer"
import { useDragDrop } from "@/components/AgentChatView/useDragDrop"
import { useToastStore } from "@/stores/useToastStore"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

/**
 * Mirrors the production tree: ``FloatingInputComposer`` renders *inside* the
 * ``<main>`` element that ``useDragDrop`` owns (AgentChatView/index.tsx), and
 * both the bar and ``<main>`` carry drop handlers. A drop landing on the pill
 * is seen by both — it must still attach the file exactly once, and must
 * still clear the drag overlay.
 */
function DropHarness() {
  const ref = useRef<InputComposerHandle>(null)
  const { isDraggingFile, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } =
    useDragDrop(ref)
  return (
    <div
      data-testid="main"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDraggingFile && <span>Drop files to attach</span>}
      <InputComposer ref={ref} onSubmit={() => {}} />
    </div>
  )
}

function pillElement(): HTMLElement {
  const textarea = screen.getByLabelText("Message input")
  // textarea → overlay wrapper → input row → pill
  return textarea.closest("div")!.parentElement!.parentElement!
}

function fileTransfer(files: File[]) {
  return { dataTransfer: { types: ["Files"], files } }
}

/** A drop carrying a directory — the entry API is how browsers reveal it. */
function folderTransfer(folder: File) {
  return {
    dataTransfer: {
      types: ["Files"],
      items: Object.assign(
        [{ kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) }],
        { length: 1 },
      ),
      files: Object.assign([folder], { length: 1 }),
    },
  }
}

describe("InputComposer drag-and-drop", () => {
  it("attaches a file dropped on the pill exactly once", () => {
    render(<DropHarness />)

    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    fireEvent.drop(pillElement(), fileTransfer([file]))

    expect(screen.getAllByText("hello.txt")).toHaveLength(1)
  })

  it("attaches a file dropped on the surrounding column exactly once", () => {
    render(<DropHarness />)

    const file = new File(["hello"], "notes.md", { type: "text/markdown" })
    fireEvent.drop(screen.getByTestId("main"), fileTransfer([file]))

    expect(screen.getAllByText("notes.md")).toHaveLength(1)
  })

  it("does not attach a dropped folder", () => {
    render(<DropHarness />)
    const folder = new File([], "my-project", { type: "" })

    fireEvent.drop(pillElement(), folderTransfer(folder))

    expect(screen.queryByText("my-project")).toBeNull()
  })

  // A folder dropped on the window was ignored without a word.
  it("says once that a folder cannot be attached, wherever it is dropped", () => {
    useToastStore.setState({ toasts: [] })
    render(<DropHarness />)
    const folder = new File([], "my-project", { type: "" })

    fireEvent.drop(pillElement(), folderTransfer(folder))
    expect(useToastStore.getState().toasts.map((t) => [t.tone, t.title])).toEqual([["info", "Folders can't be attached"]])

    useToastStore.setState({ toasts: [] })
    fireEvent.drop(screen.getByTestId("main"), folderTransfer(folder))
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Folders can't be attached"])
  })

  it("says nothing for a drop of files", () => {
    useToastStore.setState({ toasts: [] })
    render(<DropHarness />)

    fireEvent.drop(pillElement(), fileTransfer([new File(["hello"], "hello.txt", { type: "text/plain" })]))

    expect(useToastStore.getState().toasts).toEqual([])
  })

  it("clears the drag overlay after a drop on the pill", () => {
    render(<DropHarness />)
    const main = screen.getByTestId("main")

    fireEvent.dragEnter(main, fileTransfer([]))
    expect(screen.queryByText("Drop files to attach")).not.toBeNull()

    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    fireEvent.drop(pillElement(), fileTransfer([file]))

    expect(screen.queryByText("Drop files to attach")).toBeNull()
  })
})

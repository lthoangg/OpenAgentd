import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { InputBar } from "@/components/InputBar"
import { MAX_TOTAL_ATTACHMENT_BYTES, splitFilesByBudget } from "@/components/InputBar.files"
import { useToastStore } from "@/stores/useToastStore"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)
beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

/** A file of an arbitrary reported size, without allocating the bytes. */
function sizedFile(name: string, size: number): File {
  const file = new File(["x"], name, { type: "application/octet-stream" })
  Object.defineProperty(file, "size", { value: size })
  return file
}

const MB = 1024 * 1024

describe("splitFilesByBudget", () => {
  it("accepts files that fit within the budget", () => {
    const { accepted, rejected } = splitFilesByBudget([], [sizedFile("a.bin", 10 * MB)])

    expect(accepted.map((f) => f.name)).toEqual(["a.bin"])
    expect(rejected).toEqual([])
  })

  it("rejects a single file larger than the whole budget", () => {
    const huge = sizedFile("movie.mov", MAX_TOTAL_ATTACHMENT_BYTES + 1)

    const { accepted, rejected } = splitFilesByBudget([], [huge])

    expect(accepted).toEqual([])
    expect(rejected.map((f) => f.name)).toEqual(["movie.mov"])
  })

  it("counts already-attached files against the budget", () => {
    const existing = [sizedFile("attached.bin", MAX_TOTAL_ATTACHMENT_BYTES - MB)]

    const { accepted, rejected } = splitFilesByBudget(existing, [sizedFile("next.bin", 2 * MB)])

    expect(accepted).toEqual([])
    expect(rejected.map((f) => f.name)).toEqual(["next.bin"])
  })

  it("keeps the files that fit and rejects only the overflow", () => {
    const { accepted, rejected } = splitFilesByBudget(
      [],
      [
        sizedFile("small.bin", MB),
        sizedFile("huge.bin", MAX_TOTAL_ATTACHMENT_BYTES),
        sizedFile("also-small.bin", MB),
      ],
    )

    expect(accepted.map((f) => f.name)).toEqual(["small.bin", "also-small.bin"])
    expect(rejected.map((f) => f.name)).toEqual(["huge.bin"])
  })
})

describe("InputBar attachment size limit", () => {
  function dropFiles(files: File[]) {
    const textarea = screen.getByLabelText("Message input")
    const pill = textarea.closest("div")!.parentElement!.parentElement!
    fireEvent.drop(pill, { dataTransfer: { types: ["Files"], files } })
  }

  it("does not attach a file that exceeds the request limit", () => {
    render(<InputBar onSubmit={() => {}} />)

    dropFiles([sizedFile("movie.mov", MAX_TOTAL_ATTACHMENT_BYTES + MB)])

    expect(screen.queryByText("movie.mov")).toBeNull()
  })

  it("explains why an oversize file was not attached", () => {
    render(<InputBar onSubmit={() => {}} />)

    dropFiles([sizedFile("movie.mov", MAX_TOTAL_ATTACHMENT_BYTES + MB)])

    const toast = useToastStore.getState().toasts[0]
    expect(toast?.tone).toBe("error")
    expect(toast?.description).toContain("movie.mov")
  })

  it("still attaches files that fit", () => {
    render(<InputBar onSubmit={() => {}} />)

    dropFiles([sizedFile("notes.txt", MB)])

    expect(screen.getByText("notes.txt")).not.toBeNull()
    expect(useToastStore.getState().toasts).toEqual([])
  })
})

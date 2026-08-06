import { describe, it, expect } from "bun:test"
import { isDraggingFiles } from "@/lib/is-dragging-files"

/** Minimal ``DataTransfer`` stand-in — ``isDraggingFiles`` only reads ``types``. */
function transfer(types: string[]): DataTransfer {
  return { types } as unknown as DataTransfer
}

describe("isDraggingFiles", () => {
  it("detects an OS file drag", () => {
    expect(isDraggingFiles(transfer(["Files"]))).toBe(true)
  })

  it("detects a Firefox file drag", () => {
    expect(isDraggingFiles(transfer(["application/x-moz-file"]))).toBe(true)
  })

  it("ignores a plain text selection drag", () => {
    expect(isDraggingFiles(transfer(["text/plain"]))).toBe(false)
  })

  it("ignores an image or link dragged from another tab", () => {
    // Chrome/Safari expose these types for in-page drags; ``files`` is empty
    // on drop, so treating it as a file drag shows a drop overlay that can
    // never attach anything.
    expect(isDraggingFiles(transfer(["text/uri-list", "text/html", "text/plain"]))).toBe(false)
  })

  it("ignores a drag with no dataTransfer", () => {
    expect(isDraggingFiles(null)).toBe(false)
  })

  it("ignores a dataTransfer with no types", () => {
    expect(isDraggingFiles({} as DataTransfer)).toBe(false)
  })
})

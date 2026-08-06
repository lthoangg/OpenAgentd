import { describe, it, expect } from "bun:test"
import { filesFromDataTransfer } from "@/components/InputBar.files"

function fileItem(file: File, entry?: { isDirectory: boolean }): DataTransferItem {
  return {
    kind: "file",
    getAsFile: () => file,
    ...(entry ? { webkitGetAsEntry: () => entry } : {}),
  } as unknown as DataTransferItem
}

function stringItem(): DataTransferItem {
  return { kind: "string", getAsFile: () => null } as unknown as DataTransferItem
}

function transfer(items: DataTransferItem[] | null, files: File[]): DataTransfer {
  return {
    ...(items ? { items: Object.assign([...items], { length: items.length }) } : {}),
    files: Object.assign([...files], { length: files.length }),
  } as unknown as DataTransfer
}

const doc = new File(["hi"], "notes.md", { type: "text/markdown" })
// A dropped directory surfaces as a zero-byte, type-less File.
const folder = new File([], "my-project", { type: "" })

describe("filesFromDataTransfer", () => {
  it("returns dropped files", () => {
    const result = filesFromDataTransfer(transfer([fileItem(doc, { isDirectory: false })], [doc]))
    expect(result.map((f) => f.name)).toEqual(["notes.md"])
  })

  it("skips directories", () => {
    const result = filesFromDataTransfer(
      transfer(
        [fileItem(folder, { isDirectory: true }), fileItem(doc, { isDirectory: false })],
        [folder, doc],
      ),
    )
    expect(result.map((f) => f.name)).toEqual(["notes.md"])
  })

  it("returns nothing when only a directory was dropped", () => {
    const result = filesFromDataTransfer(
      transfer([fileItem(folder, { isDirectory: true })], [folder]),
    )
    expect(result).toEqual([])
  })

  it("ignores non-file items such as dragged text", () => {
    const result = filesFromDataTransfer(transfer([stringItem()], []))
    expect(result).toEqual([])
  })

  it("falls back to the files list when the entry API is unavailable", () => {
    const result = filesFromDataTransfer(transfer(null, [doc]))
    expect(result.map((f) => f.name)).toEqual(["notes.md"])
  })

  it("keeps files when items exist but expose no entry API", () => {
    const result = filesFromDataTransfer(transfer([fileItem(doc)], [doc]))
    expect(result.map((f) => f.name)).toEqual(["notes.md"])
  })

  it("returns an empty list for a null dataTransfer", () => {
    expect(filesFromDataTransfer(null)).toEqual([])
  })
})

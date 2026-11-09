/**
 * The composer clears optimistically the moment a message is submitted. When
 * the send turns out to have failed, the caller restores what was cleared —
 * otherwise the text and its attachments are gone for good.
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { createRef } from "react"
import { InputComposer, type InputComposerHandle } from "@/components/InputComposer"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

function setup() {
  const ref = createRef<InputComposerHandle>()
  const submissions: { content: string; files?: File[] }[] = []
  render(
    <InputComposer
      ref={ref}
      onSubmit={(content, files) => submissions.push({ content, files })}
    />,
  )
  return { ref, submissions }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Message input") as HTMLTextAreaElement
}

function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } })
}

function submit() {
  fireEvent.keyDown(textarea(), { key: "Enter" })
}

function dropFile(file: File) {
  const pill = textarea().closest("div")!.parentElement!.parentElement!
  fireEvent.drop(pill, { dataTransfer: { types: ["Files"], files: [file] } })
}

describe("InputComposer draft restore after a failed send", () => {
  it("clears the composer on submit", () => {
    setup()
    type("hello team")

    submit()

    expect(textarea().value).toBe("")
  })

  it("puts the text back when the send is reported as failed", () => {
    const { ref } = setup()
    type("hello team")
    submit()

    act(() => ref.current!.restoreLastSubmission())

    expect(textarea().value).toBe("hello team")
  })

  it("puts the attachments back when the send is reported as failed", () => {
    const { ref } = setup()
    dropFile(new File(["hi"], "notes.md", { type: "text/markdown" }))
    type("look at this")
    submit()
    expect(screen.queryByText("notes.md")).toBeNull()

    act(() => ref.current!.restoreLastSubmission())

    expect(screen.getByText("notes.md")).not.toBeNull()
  })

  it("does not clobber a draft the user already started typing", () => {
    const { ref } = setup()
    type("first message")
    submit()
    type("second message")

    act(() => ref.current!.restoreLastSubmission())

    expect(textarea().value).toBe("second message")
  })

  it("restores at most once per submission", () => {
    const { ref } = setup()
    type("hello team")
    submit()

    act(() => ref.current!.restoreLastSubmission())
    type("")
    act(() => ref.current!.restoreLastSubmission())

    expect(textarea().value).toBe("")
  })

  it("does nothing when there is no submission to restore", () => {
    const { ref } = setup()

    act(() => ref.current!.restoreLastSubmission())

    expect(textarea().value).toBe("")
  })
})

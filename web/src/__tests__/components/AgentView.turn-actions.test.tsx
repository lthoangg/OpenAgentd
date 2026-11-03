/**
 * The footer of a finished turn (T2, T4, T6): its actions show at rest in
 * both transcript styles: Copy, Edit prompt on the turn's prompt, and "N
 * files changed". There is no Undo (Edit prompt does it) and no Regenerate.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

import { AgentView } from "@/components/AgentView"
import type { FileRefOpener } from "@/components/FileRefLink"
import { useAgentStore } from "@/stores/useAgentStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import type { ContentBlock } from "@/api/types"

const revertToMessage = mock(async (_id: unknown) => null)
const { revertToMessage: realRevert } = useAgentStore.getState()

beforeEach(() => {
  revertToMessage.mockClear()
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true, writable: true })
  act(() => { useAgentStore.setState({ sessionId: "s1", revertToMessage }) })
})

afterEach(() => {
  cleanup()
  act(() => { useAgentStore.setState({ sessionId: null, revertToMessage: realRevert }) })
  useDisplayPrefsStore.setState({ transcriptStyle: "detailed" })
})

const patchArgs = (...lines: string[]) => JSON.stringify({ patch_text: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") })

const TWO_TURNS: ContentBlock[] = [
  { id: "m1", type: "user", content: "first prompt" },
  { id: "a1", type: "text", content: "first answer", timestamp: new Date(2026, 0, 1, 10, 0) },
  { id: "m2", type: "user", content: "second prompt" },
  { id: "a2", type: "text", content: "second answer", timestamp: new Date(2026, 0, 1, 10, 5) },
]

/** The footer's action group under each finished turn, in order. */
const actionGroups = () => screen.getAllByRole("group", { name: "Turn actions" })
const names = (group: HTMLElement) => within(group).getAllByRole("button").map((b) => b.getAttribute("aria-label"))

describe("AgentView — the footer's actions", () => {
  it("shows Copy at rest, as an icon named in words, under every finished turn", () => {
    render(<AgentView blocks={TWO_TURNS} currentBlocks={[]} isWorking={false} />)

    expect(actionGroups()).toHaveLength(2)
    for (const group of actionGroups()) {
      const copy = within(group).getByRole("button", { name: "Copy response" })
      expect(copy.textContent).toBe("")
      expect(copy.className).toContain("size-6")
    }
  })

  it("offers Copy and Edit prompt on every finished turn, and no Undo or Regenerate", () => {
    render(<AgentView blocks={TWO_TURNS} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    const [first, last] = actionGroups()
    expect(names(first)).toEqual(["Copy response", "Edit prompt"])
    // Edit prompt already undoes the turn and puts the prompt back.
    expect(names(last)).toEqual(["Copy response", "Edit prompt"])
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Regenerate/ })).toBeNull()
    // Icons only: the words live in the names and the tooltips.
    for (const button of within(last).getAllByRole("button")) expect(button.textContent).toBe("")
  })

  it("has nothing that shows only on hover", () => {
    render(<AgentView blocks={TWO_TURNS} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    for (const group of actionGroups()) {
      // ``aria-hidden`` icons are fine; a ``hidden`` class is not.
      expect(group.outerHTML).not.toMatch(/opacity-0|group-hover|(?<![\w-])hidden(?![\w-])/)
    }
  })
})

describe("AgentView — Edit prompt in the footer", () => {
  it("rewinds to the prompt the turn answers, for any turn", () => {
    render(<AgentView blocks={TWO_TURNS} currentBlocks={[]} isWorking={false} />)

    const [first, last] = actionGroups()
    fireEvent.click(within(first).getByRole("button", { name: "Edit prompt" }))
    expect(revertToMessage).toHaveBeenLastCalledWith("m1")
    fireEvent.click(within(last).getByRole("button", { name: "Edit prompt" }))
    expect(revertToMessage).toHaveBeenLastCalledWith("m2")
  })

  it("is not offered for a turn with no prompt of the user's own", () => {
    render(<AgentView blocks={[{ id: "a1", type: "text", content: "an answer" }]} currentBlocks={[]} isWorking={false} />)

    expect(screen.queryByRole("button", { name: /Edit prompt/ })).toBeNull()
  })

  it("shows disabled while a later turn runs, and says when it will work", async () => {
    const user = userEvent.setup()
    render(
      <AgentView
        blocks={TWO_TURNS.slice(0, 2)}
        currentBlocks={[{ id: "m2", type: "user", content: "second prompt" }]}
        isWorking
      />,
    )

    const edit = screen.getByRole("button", { name: /Edit prompt, available when this turn ends/ })
    expect(edit.getAttribute("aria-disabled")).toBe("true")
    expect(edit.getAttribute("title")).toBeNull()
    fireEvent.click(edit)
    expect(revertToMessage).not.toHaveBeenCalled()

    await user.hover(edit)
    expect((await screen.findByRole("tooltip")).textContent).toBe("Available when this turn ends")
  })
})

describe("AgentView — files changed on the footer", () => {
  const edit: ContentBlock = {
    id: "edit",
    type: "tool",
    content: "",
    toolName: "patch",
    toolArgs: patchArgs("*** Update File: src/a.ts", "@@", "-a", "+b", "+c"),
    toolDone: true,
    toolResult: "ok",
  }
  const BLOCKS: ContentBlock[] = [
    { id: "m1", type: "user", content: "fix it" },
    edit,
    { id: "a1", type: "text", content: "Fixed.", timestamp: new Date(2026, 0, 1, 10, 0) },
  ]
  const opener = (openDiff: FileRefOpener["openDiff"]): FileRefOpener => ({ canOpen: () => true, open: () => {}, openDiff })

  for (const style of ["detailed", "reader"] as const) {
    it(`lists the files a finished turn edited in the ${style} transcript, closed until asked`, () => {
      useDisplayPrefsStore.setState({ transcriptStyle: style })
      const openDiff = mock((..._args: unknown[]) => {})
      render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} fileRefOpener={opener(openDiff)} />)

      const files = screen.getByRole("button", { name: /1 file changed/ })
      expect(files.getAttribute("aria-expanded")).toBe("false")
      expect(files.textContent).toContain("+2")
      expect(screen.queryByRole("button", { name: /src\/a\.ts/ })).toBeNull()

      fireEvent.click(files)
      expect(files.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }))
      expect(openDiff).toHaveBeenCalledWith({ path: "src/a.ts", status: "M" })
    })
  }

  it("shows the toggle, with a footer, for a turn with no answer text", () => {
    render(<AgentView blocks={[BLOCKS[0], edit]} currentBlocks={[]} isWorking={false} />)

    expect(screen.getByRole("button", { name: /1 file changed/ })).toBeTruthy()
  })

  it("lists nothing while the turn runs", () => {
    render(<AgentView blocks={[BLOCKS[0]]} currentBlocks={[edit]} isWorking />)

    expect(screen.queryByText(/files? changed/)).toBeNull()
  })

  it("pins the footer row to the top while the list is open, so a long list closes from anywhere", () => {
    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} fileRefOpener={opener(() => {})} />)
    const files = screen.getByRole("button", { name: /1 file changed/ })
    const row = files.closest("[role=group]")?.parentElement as HTMLElement
    expect(row.className).not.toContain("sticky")

    fireEvent.click(files)

    expect(row.className).toContain("sticky")
  })
})

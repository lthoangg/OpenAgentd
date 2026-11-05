import { afterEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import { AgentView } from "@/components/AgentView"
import type { ContentBlock } from "@/api/types"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

const blocks: ContentBlock[] = [
  { id: "u1", type: "user", content: "hello" },
  { id: "t1", type: "text", content: "an answer" },
]

function renderInShell(marksScrollEdge: boolean) {
  return render(
    <div data-chat-shell="">
      <AgentView blocks={blocks} currentBlocks={[]} isWorking={false} marksScrollEdge={marksScrollEdge} />
    </div>,
  )
}

function scrollTo(scroller: HTMLElement, top: number) {
  act(() => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event("scroll"))
  })
}

describe("AgentView — scroll edge", () => {
  it("marks the shell once the transcript scrolls off its top, and clears it back at the top", () => {
    const { container } = renderInShell(true)
    const shell = container.querySelector<HTMLElement>("[data-chat-shell]")!
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller], .overflow-y-auto")!
    scrollTo(scroller, 0)
    expect(shell.hasAttribute("data-transcript-scrolled")).toBe(false)
    scrollTo(scroller, 40)
    expect(shell.hasAttribute("data-transcript-scrolled")).toBe(true)
    scrollTo(scroller, 0)
    expect(shell.hasAttribute("data-transcript-scrolled")).toBe(false)
  })

  it("leaves the shell alone for a transcript that is not the main one", () => {
    const { container } = renderInShell(false)
    const shell = container.querySelector<HTMLElement>("[data-chat-shell]")!
    const scroller = container.querySelector<HTMLElement>("[data-transcript-scroller], .overflow-y-auto")!
    scrollTo(scroller, 40)
    expect(shell.hasAttribute("data-transcript-scrolled")).toBe(false)
  })
})

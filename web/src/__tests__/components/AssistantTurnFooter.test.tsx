import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { AssistantTurn, AssistantTurnFooter } from "@/components/AssistantTurnFooter"
import type { ContentBlock } from "@/api/types"

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() },
    configurable: true,
    writable: true,
  })
})

afterEach(cleanup)

/**
 * `isStreaming` drives the typewriter animation (and its rAF loop). Flagging
 * every block of the live turn kept finished text/thinking blocks animating
 * for the whole turn — including the minutes a `pytest` / `bun test` shell
 * call is running, when nothing in the transcript is changing at all.
 */
describe("AssistantTurn — which blocks count as streaming", () => {
  const blocks: ContentBlock[] = [
    { id: "text-1", type: "text", content: "Let me run the tests." },
    {
      id: "tool-1",
      type: "tool",
      content: "",
      toolName: "shell",
      toolArgs: '{"command":"bun test"}',
      toolCallId: "call-1",
      toolDone: false,
    },
  ]

  function renderTurn(isWorking: boolean) {
    const streaming: Record<string, boolean> = {}
    render(
      <AssistantTurn
        blocks={blocks}
        startIndex={0}
        finalizedCount={0}
        isWorking={isWorking}
        isTrailingTurn
        totalBlocks={blocks.length}
        renderBlock={({ block, isStreaming }) => {
          streaming[block.id] = isStreaming
          return null
        }}
      />,
    )
    return streaming
  }

  it("streams only the trailing block while a tool call runs", () => {
    const streaming = renderTurn(true)
    expect(streaming["tool-1"]).toBe(true)
    expect(streaming["text-1"]).toBe(false)
  })

  it("marks nothing as streaming once the turn is no longer working", () => {
    const streaming = renderTurn(false)
    expect(streaming["tool-1"]).toBe(false)
    expect(streaming["text-1"]).toBe(false)
  })
})

describe("AssistantTurnFooter", () => {
  it("shows response duration after copy, continue, and timestamp controls", () => {
    const blocks: ContentBlock[] = [{
      id: "b1",
      type: "text",
      content: "Assistant answer",
      timestamp: new Date("2026-05-23T12:34:56Z"),
      responseDurationMs: 1234,
    }]

    render(<AssistantTurnFooter turnBlocks={blocks} onContinue={() => undefined} />)

    expect(screen.getByLabelText("Copy response")).toBeTruthy()
    expect(screen.getByLabelText("Continue response")).toBeTruthy()
    expect(screen.getByText("12:34")).toBeTruthy()
    expect(screen.getByTitle("Response duration").textContent).toBe("1.2s")
  })

  it("shows long response durations as minutes and seconds", () => {
    const blocks: ContentBlock[] = [{
      id: "b1",
      type: "text",
      content: "Assistant answer",
      responseDurationMs: 93_000,
    }]

    render(<AssistantTurnFooter turnBlocks={blocks} />)

    expect(screen.getByTitle("Response duration").textContent).toBe("1m 33s")
  })
})

/**
 * A turn suspended on `ask_user` is *open*, not finished: nothing is streaming,
 * but the user has not got an answer back yet. Treating "not streaming" as
 * "finished" puts a duration and a Continue button under a turn that is still
 * waiting on the question card right above them.
 */
describe("AssistantTurn — a turn suspended on a question", () => {
  const blocks: ContentBlock[] = [{
    id: "b1",
    type: "text",
    content: "Which package manager?",
    responseDurationMs: 1234,
  }]

  function renderTurn(isTurnOpen: boolean) {
    return render(
      <AssistantTurn
        blocks={blocks}
        startIndex={0}
        finalizedCount={1}
        isWorking={false}
        isTurnOpen={isTurnOpen}
        isTrailingTurn
        totalBlocks={1}
        onContinue={() => undefined}
        renderBlock={({ block }: { block: ContentBlock }) => <div>{block.content}</div>}
      />,
    )
  }

  it("offers no Continue while the turn is still open", () => {
    renderTurn(true)

    expect(screen.queryByLabelText("Continue response")).toBeNull()
  })

  it("shows no response duration while the turn is still open", () => {
    renderTurn(true)

    expect(screen.queryByTitle("Response duration")).toBeNull()
  })

  it("restores both once the turn actually ends", () => {
    renderTurn(false)

    expect(screen.getByLabelText("Continue response")).toBeTruthy()
    expect(screen.getByTitle("Response duration").textContent).toBe("1.2s")
  })
})

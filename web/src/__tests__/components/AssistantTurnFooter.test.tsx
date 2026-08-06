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

import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"
import { useRef, useState } from "react"
import { render, screen, cleanup, act } from "@testing-library/react"
import { AgentPane } from "@/components/AgentPane"
import { useAgentStore } from "@/stores/useAgentStore"
import type { AgentStream } from "@/stores/useAgentStore"
import type { ContentBlock } from "@/api/types"

afterEach(cleanup)

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [],
    currentBlocks: [],
    currentText: "",
    currentThinking: "",
    status: "idle",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    ...overrides,
  }
}

function textBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

/** Wrap a stream so every property read is counted. */
function counted(stream: AgentStream, onRead: () => void): AgentStream {
  return new Proxy(stream as object, {
    get(target, prop, recv) {
      onRead()
      return Reflect.get(target, prop, recv)
    },
  }) as AgentStream
}

/**
 * Parent views subscribe to the whole `agentStreams` map, whose identity changes
 * on every ~16ms SSE delta batch (immer copy-on-write walks to the root). Before
 * `AgentPane` was memoised, one agent's streamed token re-rendered every pane in
 * the grid.
 *
 * Two independent halves have to hold for that fix to work, and both are pinned
 * here:
 *   1. `AgentPane` bails out when its `stream` prop is referentially unchanged.
 *   2. The store's immer reducer actually leaves other agents' stream objects at
 *      the same reference — the fragile half, since any reducer rewrite that
 *      rebuilds the map (dropping immer, `Object.fromEntries(...)`, etc.) would
 *      silently restore the storm while leaving the memo in place.
 */
describe("AgentPane — memo boundary", () => {
  it("is wrapped in React.memo", () => {
    expect((AgentPane as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    )
  })

  // `React.memo` compares props by reference and never reads their properties,
  // so a counting Proxy on `stream` registers a hit only when the component's
  // function body actually executes. (A `React.Profiler` wrapper cannot answer
  // this — its `onRender` fires whenever the Profiler itself re-renders, even
  // when the memoised child bails out.)
  for (const paneCount of [2, 4, 6]) {
    it(`with ${paneCount} panes, a one-agent delta runs only the changed pane's body`, () => {
      const names = Array.from({ length: paneCount }, (_, i) => `agent${i}`)
      const reads: number[] = names.map(() => 0)

      function Harness() {
        // Stable proxy identity per pane, mirroring how immer leaves untouched
        // agents' stream objects alone.
        const stable = useRef<AgentStream[] | null>(null)
        if (stable.current === null) {
          stable.current = names.map((n, i) =>
            counted(makeStream({ currentBlocks: [textBlock("b1", `${n} v0`)] }), () => {
              reads[i]++
            }),
          )
        }
        const [changed, setChanged] = useState<AgentStream | null>(null)

        return (
          <>
            <button
              onClick={() =>
                setChanged(
                  counted(
                    makeStream({ currentBlocks: [textBlock("b1", "agent0 v1")] }),
                    () => {
                      reads[0]++
                    },
                  ),
                )
              }
            >
              tick
            </button>
            {names.map((n, i) => (
              <AgentPane
                key={n}
                name={n}
                stream={i === 0 && changed ? changed : stable.current![i]}
                isLead={false}
              />
            ))}
          </>
        )
      }

      render(<Harness />)
      expect(reads.every((r) => r > 0)).toBe(true) // every pane mounted

      reads.fill(0)
      act(() => {
        screen.getByText("tick").click()
      })

      expect(reads[0]).toBeGreaterThan(0) // the pane that got the delta re-rendered
      expect(reads.slice(1).every((r) => r === 0)).toBe(true) // no other pane did
      expect(reads.filter((r) => r > 0).length).toBe(1)
      expect(screen.getByText("agent0 v1")).toBeTruthy()
    })
  }

  it("still re-renders when its own stream prop changes", () => {
    function Harness() {
      const [stream, setStream] = useState(() =>
        makeStream({ currentBlocks: [textBlock("a1", "first text")] }),
      )
      return (
        <>
          <button
            onClick={() =>
              setStream(makeStream({ currentBlocks: [textBlock("a1", "second text")] }))
            }
          >
            advance
          </button>
          <AgentPane name="alpha" stream={stream} isLead={false} />
        </>
      )
    }

    render(<Harness />)
    expect(screen.getByText("first text")).toBeTruthy()

    act(() => {
      screen.getByText("advance").click()
    })

    expect(screen.getByText("second text")).toBeTruthy()
  })
})

describe("agentStreams structural sharing (what makes the memo effective)", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: "session-1",
      leadName: "alpha",
      agentNames: ["alpha", "beta"],
      agentStreams: { alpha: makeStream(), beta: makeStream() },
    })
  })

  it("leaves an untouched agent's stream at the same reference when another streams", () => {
    const before = useAgentStore.getState().agentStreams
    const betaBefore = before.beta
    const alphaBefore = before.alpha

    act(() => {
      useAgentStore.getState()._handleSSEEvent("message", {
        agent: "alpha",
        text: "hello from alpha",
      })
    })

    const after = useAgentStore.getState().agentStreams
    expect(after.alpha).not.toBe(alphaBefore) // alpha advanced
    expect(after.beta).toBe(betaBefore) // beta must be untouched by reference
  })

  it("holds across many consecutive deltas to one agent", () => {
    const betaBefore = useAgentStore.getState().agentStreams.beta

    act(() => {
      for (let i = 0; i < 25; i++) {
        useAgentStore.getState()._handleSSEEvent("message", {
          agent: "alpha",
          text: `chunk ${i} `,
        })
      }
    })

    expect(useAgentStore.getState().agentStreams.beta).toBe(betaBefore)
    const alphaText = useAgentStore
      .getState()
      .agentStreams.alpha.currentBlocks.map((b) => b.content)
      .join("")
    expect(alphaText).toContain("chunk 24")
  })

  it("advances both agents' references when both stream", () => {
    const before = useAgentStore.getState().agentStreams

    act(() => {
      useAgentStore.getState()._handleSSEEvent("message", { agent: "alpha", text: "a" })
      useAgentStore.getState()._handleSSEEvent("message", { agent: "beta", text: "b" })
    })

    const after = useAgentStore.getState().agentStreams
    expect(after.alpha).not.toBe(before.alpha)
    expect(after.beta).not.toBe(before.beta)
  })
})

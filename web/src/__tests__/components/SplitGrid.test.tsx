import { afterEach, describe, expect, it, mock } from "bun:test"
import React from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { AgentStream } from "@/stores/useTeamStore"

afterEach(cleanup)

// Stub framer-motion before importing the component under test. Other test
// files (ToolCall.*) install the same stub via `mock.module`, and bun's mock
// registry is process-wide — even with `--isolate`. Pinning the stub here
// makes this file deterministic regardless of test execution order.
const _motionCache: Record<string, React.FC> = {}
const motionProxy = new Proxy({}, {
  get: (_t, tag: string) => {
    if (!_motionCache[tag]) {
      _motionCache[tag] = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(tag, props, children)
    }
    return _motionCache[tag]
  },
})
mock.module("framer-motion", () => ({
  motion: motionProxy,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}))

mock.module("@/components/AgentPane", () => ({
  AgentPane: ({ name }: { name: string }) => <section>{name}</section>,
}))

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

function makeStreams(names: string[]): Record<string, AgentStream> {
  return Object.fromEntries(names.map((name) => [name, makeStream()]))
}

async function renderGrid(agentNames: string[], streams = makeStreams(agentNames)) {
  const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
  const result = render(
    <SplitGrid
      agentNames={agentNames}
      leadName="lead"
      agentStreams={streams}
    />,
  )
  const root = result.container.firstElementChild as HTMLElement | null
  return { ...result, root }
}

function columnTexts(root: HTMLElement | null): string[][] {
  if (!root) return []
  return Array.from(root.children).map((column) =>
    Array.from(column.children).map((pane) => pane.textContent ?? ""),
  )
}

describe("SplitGrid automatic layout", () => {
  it("renders one agent as a single full-height column", async () => {
    const { root } = await renderGrid(["lead"])

    expect(columnTexts(root)).toHaveLength(1)
    expect(screen.getAllByText("lead")).toHaveLength(1)
  })

  it("adds a second spawned agent as a side-by-side column", async () => {
    const { root } = await renderGrid(["lead", "executor#1"])

    const columns = columnTexts(root)
    expect(columns).toHaveLength(2)
    expect(columns[0][0]).toContain("lead")
    expect(columns[1][0]).toContain("executor#1")
  })

  it("places the third spawned agent under the right column", async () => {
    const { root } = await renderGrid(["lead", "executor#1", "reviewer#1"])

    const columns = columnTexts(root)
    expect(columns).toHaveLength(2)
    expect(columns[0]).toHaveLength(1)
    expect(columns[0][0]).toContain("lead")
    expect(columns[1]).toHaveLength(2)
    expect(columns[1][0]).toContain("executor#1")
    expect(columns[1][1]).toContain("reviewer#1")
  })

  it("grows to three columns at five agents and stacks extra panes to the right", async () => {
    const { root } = await renderGrid([
      "lead",
      "executor#1",
      "executor#2",
      "reviewer#1",
      "reviewer#2",
    ])

    const columns = columnTexts(root)
    expect(columns).toHaveLength(3)
    expect(columns[0]).toHaveLength(1)
    expect(columns[0][0]).toContain("lead")
    expect(columns[1]).toHaveLength(2)
    expect(columns[1][0]).toContain("executor#1")
    expect(columns[1][1]).toContain("executor#2")
    expect(columns[2]).toHaveLength(2)
    expect(columns[2][0]).toContain("reviewer#1")
    expect(columns[2][1]).toContain("reviewer#2")
  })

  it("ignores transient roster entries that do not have streams yet", async () => {
    const { root } = await renderGrid(["lead", "executor#1"], makeStreams(["lead"]))

    const columns = columnTexts(root)
    expect(columns).toHaveLength(1)
    expect(columns[0][0]).toContain("lead")
    expect(screen.queryByText("executor#1")).toBeNull()
  })

  it("hides offline members from split panes", async () => {
    const streams = {
      ...makeStreams(["lead", "executor#1"]),
      "executor#1": makeStream({ status: "offline" }),
    }

    const { root } = await renderGrid(["lead", "executor#1"], streams)

    const columns = columnTexts(root)
    expect(columns).toHaveLength(1)
    expect(columns[0][0]).toContain("lead")
    expect(screen.queryByText("executor#1")).toBeNull()
  })

  it("lets remaining agents reclaim dismissed member space", async () => {
    const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
    const initialStreams = makeStreams(["lead", "executor#1"])
    const { container, rerender } = render(
      <SplitGrid agentNames={["lead", "executor#1"]} leadName="lead" agentStreams={initialStreams} />,
    )

    rerender(
      <SplitGrid
        agentNames={["lead", "executor#1"]}
        leadName="lead"
        agentStreams={{
          ...initialStreams,
          "executor#1": makeStream({ status: "offline" }),
        }}
      />,
    )

    const columns = columnTexts(container.firstElementChild as HTMLElement | null)
    expect(columns).toHaveLength(1)
    expect(columns[0][0]).toContain("lead")
    expect(screen.queryByText("executor#1")).toBeNull()
  })

  it("reflows larger grids when a middle pane goes offline", async () => {
    const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
    const names = ["lead", "executor#1", "executor#2", "reviewer#1", "reviewer#2"]
    const initialStreams = makeStreams(names)
    const { container, rerender } = render(
      <SplitGrid agentNames={names} leadName="lead" agentStreams={initialStreams} />,
    )

    expect(columnTexts(container.firstElementChild as HTMLElement | null)).toEqual([
      ["lead"],
      ["executor#1", "executor#2"],
      ["reviewer#1", "reviewer#2"],
    ])

    rerender(
      <SplitGrid
        agentNames={names}
        leadName="lead"
        agentStreams={{
          ...initialStreams,
          "executor#1": makeStream({ status: "offline" }),
        }}
      />,
    )

    // Use waitFor so this test stays correct whether framer-motion is real
    // (exit animation delays unmount ~150ms) or stubbed (synchronous).
    await waitFor(() => {
      expect(columnTexts(container.firstElementChild as HTMLElement | null)).toEqual([
        ["lead", "executor#2"],
        ["reviewer#1", "reviewer#2"],
      ])
      expect(screen.queryByText("executor#1")).toBeNull()
    })
  })

  it("renders nothing when every known stream is offline", async () => {
    const streams = {
      lead: makeStream({ status: "offline" }),
      "executor#1": makeStream({ status: "offline" }),
    }

    const { root } = await renderGrid(["lead", "executor#1"], streams)

    expect(root).toBeNull()
    expect(screen.queryByText("lead")).toBeNull()
    expect(screen.queryByText("executor#1")).toBeNull()
  })

  it("renders nothing when agentNames is empty", async () => {
    const { root } = await renderGrid([])
    expect(root).toBeNull()
  })
})

describe("SplitGrid spawn / dismiss animation", () => {
  // Note: the "reflows larger grids when a middle pane goes offline" test in
  // the layout suite already exercises AnimatePresence: it needs `waitFor`
  // because the dismissed pane stays mounted during its exit animation. That
  // covers the "keeps pane mounted during exit" path implicitly.

  it("re-mounts an agent that returns from offline to idle (re-spawn)", async () => {
    const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
    const names = ["lead", "executor#1"]
    const offlineStreams = {
      ...makeStreams(names),
      "executor#1": makeStream({ status: "offline" }),
    }
    const { container, rerender } = render(
      <SplitGrid agentNames={names} leadName="lead" agentStreams={offlineStreams} />,
    )

    expect(screen.queryByText("executor#1")).toBeNull()

    // Agent comes back online — store keeps it in `agentNames`, flips status.
    rerender(
      <SplitGrid
        agentNames={names}
        leadName="lead"
        agentStreams={makeStreams(names)}
      />,
    )

    expect(screen.queryByText("executor#1")).not.toBeNull()
    expect(columnTexts(container.firstElementChild as HTMLElement | null)).toEqual([
      ["lead"],
      ["executor#1"],
    ])
  })

  it("does not remount a pane when only its stream content changes", async () => {
    // Panes are keyed by agent name. Replacing the stream object (new message
    // arrived) must NOT cause React to unmount + remount the pane, otherwise
    // the spawn animation would replay on every SSE update.
    const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
    const initial = makeStreams(["lead"])
    const { container, rerender } = render(
      <SplitGrid agentNames={["lead"]} leadName="lead" agentStreams={initial} />,
    )
    const firstPane = container
      .firstElementChild!.firstElementChild!.firstElementChild as HTMLElement

    rerender(
      <SplitGrid
        agentNames={["lead"]}
        leadName="lead"
        agentStreams={{ lead: makeStream({ status: "working", currentText: "hello" }) }}
      />,
    )
    const secondPane = container
      .firstElementChild!.firstElementChild!.firstElementChild as HTMLElement

    // Same DOM node identity → React kept the element, no remount.
    expect(secondPane).toBe(firstPane)
  })

  it("dismisses the lead agent like any other pane", async () => {
    const { SplitGrid } = await import("@/components/TeamChatView/SplitGrid")
    const initial = makeStreams(["lead", "executor#1"])
    const { container, rerender } = render(
      <SplitGrid agentNames={["lead", "executor#1"]} leadName="lead" agentStreams={initial} />,
    )

    rerender(
      <SplitGrid
        agentNames={["lead", "executor#1"]}
        leadName="lead"
        agentStreams={{ ...initial, lead: makeStream({ status: "offline" }) }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText("lead")).toBeNull()
    })
    expect(columnTexts(container.firstElementChild as HTMLElement | null)).toEqual([
      ["executor#1"],
    ])
  })
})

// Note: a reduced-motion test was intentionally omitted. With framer-motion
// stubbed (above), all transitions are zero-duration regardless of the
// `useReducedMotion` hook, so the assertion would not exercise the branch.
// The branch is small (one ternary in the component) and the contract is
// enforced by inspection; testing it meaningfully would require running
// real framer-motion, which other tests in this repo opt out of.

import { describe, expect, it } from "bun:test"
import type { ContentBlock } from "@/api/types"
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns } from "@/utils/turns"

function user(id: string): ContentBlock {
  return { id, type: "user", content: id }
}

function text(id: string): ContentBlock {
  return { id, type: "text", content: id }
}

function report(id: string, fromAgent = "explorer#1"): ContentBlock {
  return { id, type: "user", content: id, extra: { from_agent: fromAgent } }
}

const ids = (item: ReturnType<typeof partitionTurns>[number]) =>
  item.kind === "assistant" ? item.blocks.map((block) => block.id) : [item.block.id]

function compaction(id: string, forced = true): ContentBlock {
  return { id, type: "compaction", content: id, extra: forced ? { state: "compacted", forced: true } : { state: "compacted" } }
}

describe("partitionTurns — compaction", () => {
  it("sets a forced compaction after a reply apart from that reply", () => {
    const result = partitionTurns([user("u1"), text("a1"), compaction("c1"), user("u2"), text("a2")])
    expect(result.map((item) => item.kind)).toEqual(["user", "assistant", "compaction", "user", "assistant"])
    expect(result.map(ids)).toEqual([["u1"], ["a1"], ["c1"], ["u2"], ["a2"]])
    expect(result[2]).toMatchObject({ kind: "compaction", index: 2 })
  })

  it("sets a trailing forced compaction apart", () => {
    expect(partitionTurns([user("u1"), text("a1"), compaction("c1")]).map((item) => item.kind)).toEqual(["user", "assistant", "compaction"])
  })

  it("keeps an auto-compaction inside its run", () => {
    expect(partitionTurns([user("u1"), text("a1"), compaction("c1", false), text("a2")]).map(ids)).toEqual([["u1"], ["a1", "c1", "a2"]])
    expect(partitionTurns([user("u1"), text("a1"), compaction("c1", false)]).map(ids)).toEqual([["u1"], ["a1", "c1"]])
  })

  it("keeps a forced compaction that lands inside a turn as one of its steps", () => {
    expect(partitionTurns([user("u1"), text("a1"), compaction("c1"), text("a2")]).map(ids)).toEqual([["u1"], ["a1", "c1", "a2"]])
  })

  it("does not merge a live reply into the turn before a forced compaction", () => {
    const finalized = partitionTurns([user("u1"), text("a1"), compaction("c1")])
    const result = appendCurrentTurns(finalized, 3, [user("u2"), text("live")])
    expect(result.map(ids)).toEqual([["u1"], ["a1"], ["c1"], ["u2"], ["live"]])
    expect(result[4]).toMatchObject({ kind: "assistant", startIndex: 4 })
  })
})

describe("partitionTurns", () => {
  it("groups contiguous assistant blocks between user blocks", () => {
    const result = partitionTurns([
      user("u1"),
      text("a1"),
      { id: "tool1", type: "tool", content: "", toolName: "read", toolDone: true },
      user("u2"),
      text("a2"),
    ])

    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ kind: "user", index: 0 })
    expect(result[1]).toMatchObject({ kind: "assistant", startIndex: 1 })
    expect(result[1].kind === "assistant" ? result[1].blocks.map((block) => block.id) : []).toEqual(["a1", "tool1"])
    expect(result[2]).toMatchObject({ kind: "user", index: 3 })
    expect(result[3]).toMatchObject({ kind: "assistant", startIndex: 4 })
  })

  it("keeps an agent's report as its own item by default", () => {
    expect(partitionTurns([user("u1"), text("a1"), report("r1"), text("a2")]).map(ids)).toEqual([["u1"], ["a1"], ["r1"], ["a2"]])
  })

  it("folds a report that arrives after the agent's work into that turn", () => {
    const result = partitionTurns([user("u1"), text("a1"), report("r1"), report("r2"), text("a2"), user("u2")], { foldAgentReports: true })

    expect(result.map(ids)).toEqual([["u1"], ["a1", "r1", "r2", "a2"], ["u2"]])
    expect(result[1]).toMatchObject({ kind: "assistant", startIndex: 1 })
  })

  it("keeps an agent's message that opens a turn, e.g. a lead's task, as its prompt", () => {
    expect(partitionTurns([report("task", "lead"), text("a1"), user("u1"), report("r1"), text("a2")], { foldAgentReports: true }).map(ids))
      .toEqual([["task"], ["a1"], ["u1"], ["r1"], ["a2"]])
  })

  it("does not fold a message the user sent through the agent inbox", () => {
    expect(partitionTurns([user("u1"), text("a1"), report("u2", "user"), text("a2")], { foldAgentReports: true }).map(ids))
      .toEqual([["u1"], ["a1"], ["u2"], ["a2"]])
  })
})

describe("appendCurrentTurns", () => {
  it("reuses finalized turns and only partitions the live suffix", () => {
    const finalized = partitionTurns([user("u1"), text("a1"), user("u2"), text("a2")])

    const result = appendCurrentTurns(finalized, 4, [text("live")])

    expect(result).toHaveLength(4)
    expect(result[0]).toBe(finalized[0])
    expect(result[1]).toBe(finalized[1])
    expect(result[2]).toBe(finalized[2])
    expect(result[3]).toMatchObject({ kind: "assistant", startIndex: 3 })
    expect(result[3].kind === "assistant" ? result[3].blocks.map((block) => block.id) : []).toEqual(["a2", "live"])
  })

  it("keeps a user-led live suffix as separate turns with finalized offsets", () => {
    const finalized = partitionTurns([user("u1"), text("a1")])

    const result = appendCurrentTurns(finalized, 2, [user("u2"), text("live")])

    expect(
      result.map((item) =>
        item.kind === "assistant"
          ? { kind: item.kind, startIndex: item.startIndex }
          : { kind: item.kind, index: item.index },
      ),
    ).toEqual([
      { kind: "user", index: 0 },
      { kind: "assistant", startIndex: 1 },
      { kind: "user", index: 2 },
      { kind: "assistant", startIndex: 3 },
    ])
  })

  it("folds a live report into the finalized turn it follows", () => {
    const finalized = partitionTurns([user("u1"), text("a1")], { foldAgentReports: true })

    const result = appendCurrentTurns(finalized, 2, [report("r1"), text("live")], { foldAgentReports: true })

    expect(result.map(ids)).toEqual([["u1"], ["a1", "r1", "live"]])
  })
})

describe("getVisibleTurnWindow", () => {
  const turns = partitionTurns([
    user("u1"),
    text("a1"),
    user("u2"),
    text("a2"),
    user("u3"),
  ])

  it("returns all turns when rendered count covers the list", () => {
    const result = getVisibleTurnWindow(turns, turns.length)

    expect(result.hiddenTurnCount).toBe(0)
    expect(result.visibleTurnItems).toBe(turns)
  })

  it("returns the latest rendered window when older turns are hidden", () => {
    const result = getVisibleTurnWindow(turns, 2)

    expect(result.hiddenTurnCount).toBe(3)
    expect(result.visibleTurnItems).toEqual(turns.slice(3))
  })

  it("clamps hidden count to zero for oversized rendered counts", () => {
    const result = getVisibleTurnWindow(turns, 999)

    expect(result.hiddenTurnCount).toBe(0)
    expect(result.visibleTurnItems).toBe(turns)
  })
})

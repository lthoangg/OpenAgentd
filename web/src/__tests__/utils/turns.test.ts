import { describe, expect, it } from "bun:test"
import type { ContentBlock } from "@/api/types"
import { appendCurrentTurns, getVisibleTurnWindow, partitionTurns } from "@/utils/turns"

function user(id: string): ContentBlock {
  return { id, type: "user", content: id }
}

function text(id: string): ContentBlock {
  return { id, type: "text", content: id }
}

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
        item.kind === "user"
          ? { kind: item.kind, index: item.index }
          : { kind: item.kind, startIndex: item.startIndex },
      ),
    ).toEqual([
      { kind: "user", index: 0 },
      { kind: "assistant", startIndex: 1 },
      { kind: "user", index: 2 },
      { kind: "assistant", startIndex: 3 },
    ])
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

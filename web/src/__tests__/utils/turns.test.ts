import { describe, expect, it } from "bun:test"
import type { ContentBlock } from "@/api/types"
import { getVisibleTurnWindow, partitionTurns } from "@/utils/turns"

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

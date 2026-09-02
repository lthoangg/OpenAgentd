/**
 * Cursor pagination logic for useSessionsQuery.
 *
 * Two contracts matter:
 * 1. getNextPageParam — tells TanStack Query whether to fetch another page
 * 2. flattenPages — what the coding sidebar renders
 */

import { describe, it, expect } from "bun:test"
import type { SessionPageResponse, SessionResponse } from "@/api/types"
import { queryKeys } from "@/queries/keys"

function makeSession(id: string): SessionResponse {
  return { id, title: id, agent_name: "lead", created_at: null, updated_at: null }
}

function makePage(
  ids: string[],
  opts: { next_cursor?: string | null; has_more: boolean }
): SessionPageResponse {
  return { data: ids.map(makeSession), next_cursor: opts.next_cursor ?? null, has_more: opts.has_more }
}

// Mirrors useInfiniteQuery getNextPageParam in useSessionsQuery.ts
function getNextPageParam(page: SessionPageResponse): string | null | undefined {
  return page.has_more ? page.next_cursor : undefined
}

describe("getNextPageParam", () => {
  it("returns undefined when has_more=false — stops fetching", () => {
    expect(getNextPageParam(makePage([], { has_more: false }))).toBeUndefined()
  })

  it("returns the cursor when has_more=true — triggers next fetch", () => {
    const cursor = "2026-04-17T10:00:00Z"
    expect(
      getNextPageParam(makePage(["s1"], { has_more: true, next_cursor: cursor }))
    ).toBe(cursor)
  })
})

describe("flattenPages (coding sidebar sessions)", () => {
  it("concatenates pages in order", () => {
    const page1 = makePage(["a", "b"], { has_more: true, next_cursor: "t1" })
    const page2 = makePage(["c", "d"], { has_more: false })
    const flat = [page1, page2].flatMap((p) => p.data)
    expect(flat.map((s) => s.id)).toEqual(["a", "b", "c", "d"])
  })
})

describe("query key selection", () => {
  it("has a distinct key for the coding-only aggregate list", () => {
    expect(queryKeys.session.sessions.workspace("__all_coding__")).toEqual([
      "session",
      "sessions",
      "workspace",
      "__all_coding__",
    ])
  })
})

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SIDE_QUESTION_EVENT_TYPES, SSE_EVENT_TYPES } from "@/api/types"
import { GLOBAL_EVENT_TYPES } from "@/api/global-events"
import { IGNORED_SSE_EVENTS } from "@/stores/useAgentStore/sse-reducer"

// The backend asserts every event it emits is listed in this file; these
// checks keep the web client's types and handlers in step with it.
const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../appv3/crates/agent/data/sse_events.json", import.meta.url)), "utf8"),
) as { session_stream: string[]; global_stream: string[]; side_question_stream: string[] }

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8")

describe("SSE wire contract (appv3/crates/agent/data/sse_events.json)", () => {
  it("types exactly the session-stream events the backend emits", () => {
    expect([...SSE_EVENT_TYPES].sort()).toEqual([...contract.session_stream].sort())
  })

  it("types exactly the global-feed events the backend emits", () => {
    expect([...GLOBAL_EVENT_TYPES].sort()).toEqual([...contract.global_stream].sort())
  })

  it("types and handles exactly the side-question events the backend emits", () => {
    expect([...SIDE_QUESTION_EVENT_TYPES].sort()).toEqual([...contract.side_question_stream].sort())
    const store = source("stores/useBtwStore.ts")
    expect(contract.side_question_stream.filter((name) => !store.includes(`case '${name}'`))).toEqual([])
  })

  it("handles every session-stream event or ignores it on purpose", () => {
    const reducer = source("stores/useAgentStore/sse-reducer.ts")
    const unhandled = contract.session_stream.filter(
      (name) => !(name in IGNORED_SSE_EVENTS) && !reducer.includes(`case '${name}'`),
    )
    expect(unhandled).toEqual([])
    for (const name of Object.keys(IGNORED_SSE_EVENTS)) {
      expect(contract.session_stream).toContain(name)
      expect(reducer.includes(`case '${name}'`)).toBe(false)
    }
  })

  it("handles every global-feed event", () => {
    const hook = source("hooks/use-global-event-stream.ts")
    expect(contract.global_stream.filter((name) => !hook.includes(`type === '${name}'`))).toEqual([])
  })
})

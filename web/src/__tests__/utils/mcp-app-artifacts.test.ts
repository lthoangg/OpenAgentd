import { describe, expect, it } from "bun:test"
import type { ContentBlock } from "@/api/types"
import {
  latestMCPAppResources,
  latestMCPAppResourceBlockIdsFromParts,
} from "@/utils/mcp-app-artifacts"

function appTool(id: string, resourceUri: string): ContentBlock {
  return {
    id,
    type: "tool",
    content: "",
    toolName: "app",
    toolDone: true,
    extra: { mcp_app: { resourceUri } },
  }
}

describe("latestMCPAppResourceBlockIdsFromParts", () => {
  it("reuses finalized resource state while replacing resources from the live suffix", () => {
    const finalized = latestMCPAppResources([
      appTool("old-weather", "ui://weather"),
      appTool("stocks", "ui://stocks"),
    ])

    const result = latestMCPAppResourceBlockIdsFromParts(finalized, [appTool("new-weather", "ui://weather")])

    expect(result).toEqual(new Set(["new-weather", "stocks"]))
    expect(finalized).toEqual(new Map([
      ["ui://weather", "old-weather"],
      ["ui://stocks", "stocks"],
    ]))
  })
})

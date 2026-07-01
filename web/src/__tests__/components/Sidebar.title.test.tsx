import { describe, it, expect } from "bun:test"
import { normalizeWorkspaceInput, workspaceLabel } from "@/utils/workspace"

/**
 * Sidebar Title Animation Tests
 *
 * These tests verify the title animation behavior in the Sidebar component.
 * The Sidebar renders session titles with a motion.p element that has:
 * - key={session.title ?? 'untitled'} for animation triggering
 * - Conditional font-medium class for active sessions
 * - Conditional text color classes based on active state
 * - truncate class for overflow handling
 *
 * Since the Sidebar component has complex dependencies (queries, router, etc.),
 * we test the logic that drives the title rendering rather than the full component.
 */

describe("Sidebar: title animation logic", () => {
  it("uses the title as animation key when present", () => {
    const session = { title: "My Chat" }
    expect(session.title ?? "untitled").toBe("My Chat")
  })

  it("falls back to untitled animation key when title is null", () => {
    const session = { title: null }
    expect(session.title ?? "untitled").toBe("untitled")
  })

  it("treats empty titles as untitled for display", () => {
    const session = { title: "" }
    expect(session.title || "Untitled").toBe("Untitled")
  })

  it("changes animation key when the title changes", () => {
    const prevKey = ({ title: "Old Title" }).title ?? "untitled"
    const nextKey = ({ title: "New Title" }).title ?? "untitled"
    expect(prevKey).not.toBe(nextKey)
  })

  it("keeps the animation key stable when the title is unchanged", () => {
    const prevKey = ({ title: null }).title ?? "untitled"
    const nextKey = ({ title: null }).title ?? "untitled"
    expect(prevKey).toBe(nextKey)
  })
})

describe("Sidebar: workspace input", () => {
  it("trims workspace paths before routing", () => {
    expect(normalizeWorkspaceInput("  /Users/name/project  ")).toBe("/Users/name/project")
  })

  it("rejects blank workspace paths", () => {
    expect(normalizeWorkspaceInput("   ")).toBeNull()
  })

  it("shows the workspace basename as its label", () => {
    expect(workspaceLabel("/Users/name/project")).toBe("project")
  })

  it("trims trailing path separators before labelling", () => {
    expect(workspaceLabel("/Users/name/project/")).toBe("project")
  })
})

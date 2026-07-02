/**
 * Tests for InputBar.suggestions positioning fixes.
 *
 * Covers the three mobile bugs that were fixed:
 *
 *  1. Menus render with `position: fixed` so they escape any
 *     `overflow: hidden` ancestor (e.g. the <main> column on mobile).
 *
 *  2. Menu coordinates derive from getBoundingClientRect() so they
 *     track the actual input position in the visual viewport.
 *
 *  3. visualViewport 'resize' triggers a position recalculate so
 *     the menu repositions when the soft keyboard appears/disappears.
 */
import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InputBar } from "@/components/InputBar"
import type { FileRef } from "@/components/InputBar"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

const fixtures: FileRef[] = [
  { path: "src/api.ts", name: "api.ts", type: "file" },
  { path: "src", name: "src", type: "directory" },
]

// ── helpers ────────────────────────────────────────────────────────────────

/** Return the mention listbox once it is open. */
async function openMentionPicker() {
  const user = userEvent.setup()
  render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
  await user.type(screen.getByLabelText("Message input"), "@")
  return screen.getByRole("listbox", { name: "Reference workspace file" })
}

// ── 1. position: fixed ─────────────────────────────────────────────────────

describe("InputBarSuggestions — position: fixed", () => {
  it("mention menu has position:fixed so it escapes overflow:hidden ancestors", async () => {
    const listbox = await openMentionPicker()
    expect(listbox.style.position).toBe("fixed")
  })

  it("slash command menu has position:fixed", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[{ id: "stop", label: "Stop", description: "" }]}
      />,
    )
    await user.type(screen.getByLabelText("Message input"), "/")
    const listbox = screen.getByRole("listbox", { name: "Slash commands" })
    expect(listbox.style.position).toBe("fixed")
  })
})

// ── 2. coordinates from getBoundingClientRect ──────────────────────────────

describe("InputBarSuggestions — coordinates from getBoundingClientRect", () => {
  it("menu left matches the input bar's left edge from getBoundingClientRect", async () => {
    // Stub getBoundingClientRect on all elements to return a controlled rect
    // so we can assert the menu picks up the right value.
    const RECT = { top: 600, bottom: 640, left: 24, right: 376, width: 352, height: 40, x: 24, y: 600, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      // left should equal rect.left (24)
      expect(listbox.style.left).toBe("24px")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it("menu renders above the input (bottom set) when there is more space above than below", async () => {
    // Simulate the input near the bottom of a short visual viewport — plenty
    // of space above, very little below — so showBelow=false, and the menu
    // should pin its bottom edge to (viewportHeight - rect.top).
    const viewportHeight = 700
    Object.defineProperty(window, "innerHeight", { value: viewportHeight, configurable: true })

    const RECT = { top: 620, bottom: 660, left: 0, right: 400, width: 400, height: 40, x: 0, y: 620, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      // spaceAbove=620, spaceBelow=700-660=40 → showBelow=false
      // bottom = viewportHeight - rect.top + GAP = 700 - 620 + 4 = 84
      expect(listbox.style.bottom).toBe("84px")
      expect(listbox.style.top).toBe("")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it("menu renders below the input (top set) when there is more space below than above", async () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true })

    const RECT = { top: 100, bottom: 140, left: 0, right: 400, width: 400, height: 40, x: 0, y: 100, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      // spaceAbove=100 < threshold=280 AND spaceBelow=760 > spaceAbove → showBelow=true
      // top = rect.bottom + GAP = 140 + 4 = 144
      expect(listbox.style.top).toBe("144px")
      expect(listbox.style.bottom).toBe("")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })
})

// ── 3. visualViewport resize triggers repositioning ────────────────────────

describe("InputBarSuggestions — visualViewport resize", () => {
  it("recalculates position when visualViewport fires a resize event", async () => {
    // Set up a fake visualViewport with addEventListener/removeEventListener.
    const listeners: Array<() => void> = []
    const fakeVV = {
      height: 800,
      width: 400,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        const i = listeners.indexOf(fn)
        if (i !== -1) listeners.splice(i, 1)
      },
    }
    Object.defineProperty(window, "visualViewport", { value: fakeVV, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true })

    // First rect: input is near the bottom of the full viewport → menu shows
    // above (bottom set). bottom = 800 - 700 + 4 = 104px.
    const rectAbove = { top: 700, bottom: 740, left: 0, right: 400, width: 400, height: 40, x: 0, y: 700, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return rectAbove as DOMRect }

    const listbox = await openMentionPicker()
    // spaceAbove=700, spaceBelow=800-740=60 → showBelow=false → bottom is set
    expect(listbox.style.bottom).not.toBe("")
    const firstBottom = listbox.style.bottom
    expect(firstBottom).toBe("104px")

    // Simulate keyboard opening: visualViewport shrinks to 400px and the
    // input bar rides up to a new position (still near the bottom of the
    // now-smaller visible area). bottom = 400 - 320 + 4 = 84px.
    fakeVV.height = 400
    const rectAfterKeyboard = { top: 320, bottom: 360, left: 0, right: 400, width: 400, height: 40, x: 0, y: 320, toJSON: () => ({}) }
    Element.prototype.getBoundingClientRect = function () { return rectAfterKeyboard as DOMRect }

    act(() => {
      // Fire all registered visualViewport resize listeners.
      listeners.forEach((fn) => fn())
    })

    // bottom should now be recalculated: 400 - 320 + 4 = 84
    expect(listbox.style.bottom).toBe("84px")
    expect(listbox.style.bottom).not.toBe(firstBottom)

    // Cleanup
    Element.prototype.getBoundingClientRect = original
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true })
  })

  it("unregisters the visualViewport listener when the menu closes", async () => {
    const listeners: Array<() => void> = []
    const fakeVV = {
      height: 800,
      width: 400,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        const i = listeners.indexOf(fn)
        if (i !== -1) listeners.splice(i, 1)
      },
    }
    Object.defineProperty(window, "visualViewport", { value: fakeVV, configurable: true })

    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    await user.type(screen.getByLabelText("Message input"), "@")
    expect(screen.getByRole("listbox", { name: "Reference workspace file" })).toBeTruthy()
    expect(listeners.length).toBeGreaterThan(0)

    // Close the picker via Escape.
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
    // All listeners should have been removed.
    expect(listeners.length).toBe(0)

    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true })
  })
})

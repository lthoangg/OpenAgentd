/**
 * Tests for InputBar.suggestions positioning fixes.
 *
 * Covers platform-specific positioning logic:
 *
 *  1. On mobile: menus use `position: fixed` to escape `overflow: hidden` ancestors.
 *  2. On desktop: menus use `position: absolute` relative to the parent input wrapper.
 *  3. Coordinates adapt to the selected platform (fixed uses visual viewport, absolute uses parent-relative).
 */
import { describe, it, expect, afterEach, mock, beforeEach } from "bun:test"
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

// ── helpers for mobile/desktop testing ─────────────────────────────────────

/**
 * Mock the MOBILE_QUERY media query to force mobile or desktop detection.
 * Returns a cleanup function.
 */
function mockIsMobile(isMobile: boolean) {
  const originalMatchMedia = window.matchMedia
  window.matchMedia = (query: string) => {
    if (query.includes("max-width") || query.includes("max-height")) {
      return {
        matches: isMobile,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      } as MediaQueryList
    }
    return originalMatchMedia(query)
  }
  return () => {
    window.matchMedia = originalMatchMedia
  }
}

// ── 1. position: fixed (mobile) ────────────────────────────────────────────

describe("InputBarSuggestions — position: fixed (mobile)", () => {
  let cleanup: () => void
  beforeEach(() => {
    cleanup = mockIsMobile(true)
  })
  afterEach(() => {
    cleanup()
  })

  it("mention menu has position:fixed on mobile so it escapes overflow:hidden ancestors", async () => {
    const listbox = await openMentionPicker()
    expect(listbox.style.position).toBe("fixed")
  })

  it("slash command menu has position:fixed on mobile", async () => {
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

// ── 1b. position: absolute (desktop) ───────────────────────────────────────

describe("InputBarSuggestions — position: absolute (desktop)", () => {
  let cleanup: () => void
  beforeEach(() => {
    cleanup = mockIsMobile(false)
  })
  afterEach(() => {
    cleanup()
  })

  it("mention menu has position:absolute on desktop", async () => {
    const listbox = await openMentionPicker()
    expect(listbox.style.position).toBe("absolute")
  })

  it("slash command menu has position:absolute on desktop", async () => {
    const user = userEvent.setup()
    render(
      <InputBar
        onSubmit={() => {}}
        slashCommands={[{ id: "stop", label: "Stop", description: "" }]}
      />,
    )
    await user.type(screen.getByLabelText("Message input"), "/")
    const listbox = screen.getByRole("listbox", { name: "Slash commands" })
    expect(listbox.style.position).toBe("absolute")
  })

  it("desktop menu renders below the input when near the top", async () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true })

    const RECT = { top: 100, bottom: 140, left: 24, right: 376, width: 352, height: 40, x: 24, y: 100, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      expect(listbox.style.top).toBe("44px")
      expect(listbox.style.bottom).toBe("")
      expect(listbox.style.width).toBe("352px")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it("desktop menu renders above the input when near the bottom", async () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true })

    const RECT = { top: 700, bottom: 740, left: 24, right: 376, width: 352, height: 40, x: 24, y: 700, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      expect(listbox.style.top).toBe("")
      expect(listbox.style.bottom).toBe("44px")
      expect(listbox.style.width).toBe("352px")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it("desktop menu uses actual menu height to choose below when above space is too small", async () => {
    Object.defineProperty(window, "innerHeight", { value: 520, configurable: true })

    const RECT = { top: 80, bottom: 120, left: 24, right: 376, width: 352, height: 40, x: 24, y: 80, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 220 } })

    try {
      const listbox = await openMentionPicker()
      expect(listbox.style.top).toBe("44px")
      expect(listbox.style.bottom).toBe("")
    } finally {
      Element.prototype.getBoundingClientRect = original
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })

  it("desktop placement stays stable when both sides fit and space changes only slightly", async () => {
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true })

    const rectRef = { current: { top: 300, bottom: 340, left: 24, right: 376, width: 352, height: 40, x: 24, y: 300, toJSON: () => ({}) } }
    const original = Element.prototype.getBoundingClientRect
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Element.prototype.getBoundingClientRect = function () { return rectRef.current as DOMRect }
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 120 } })

    try {
      const listbox = await openMentionPicker()
      expect(listbox.style.top).toBe("44px")

      rectRef.current = { ...rectRef.current, top: 320, bottom: 360, y: 320 }
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      expect(listbox.style.top).toBe("44px")
      expect(listbox.style.bottom).toBe("")
    } finally {
      Element.prototype.getBoundingClientRect = original
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })
})

// ── 2. coordinates from getBoundingClientRect (mobile) ─────────────────────

describe("InputBarSuggestions — coordinates from getBoundingClientRect (mobile)", () => {
  let cleanup: () => void
  beforeEach(() => {
    cleanup = mockIsMobile(true)
  })
  afterEach(() => {
    cleanup()
  })

  it("menu left matches the input bar's left edge from getBoundingClientRect on mobile", async () => {
    // Stub getBoundingClientRect on all elements to return a controlled rect
    // so we can assert the menu picks up the right value.
    const RECT = { top: 600, bottom: 640, left: 24, right: 376, width: 352, height: 40, x: 24, y: 600, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      // On mobile, left should equal rect.left (24)
      expect(listbox.style.left).toBe("24px")
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })

  it("menu renders above the input (bottom set) when there is more space above than below (mobile)", async () => {
    // Simulate the input near the bottom of a short visual viewport — plenty
    // of space above, very little below — so showBelow=false, and the menu
    // should pin its bottom edge to (viewportHeight - rect.top).
    const viewportHeight = 700
    Object.defineProperty(window, "visualViewport", { value: { height: viewportHeight }, configurable: true })

    const RECT = { top: 620, bottom: 660, left: 0, right: 400, width: 400, height: 40, x: 0, y: 620, toJSON: () => ({}) }
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return RECT as DOMRect }

    try {
      const listbox = await openMentionPicker()
      // On mobile with visualViewport:
      // spaceAbove=620, spaceBelow=700-660=40 → showBelow=false
      // bottom = viewportHeight - rect.top + GAP = 700 - 620 + 4 = 84
      expect(listbox.style.bottom).toBe("84px")
      expect(listbox.style.top).toBe("")
    } finally {
      Element.prototype.getBoundingClientRect = original
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true })
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
    const cleanupMobile = mockIsMobile(true)
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
    cleanupMobile()
  })

  it("unregisters the visualViewport listener when the menu closes", async () => {
    const cleanupMobile = mockIsMobile(true)
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
    cleanupMobile()
  })
})

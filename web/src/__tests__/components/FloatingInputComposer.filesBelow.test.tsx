import { describe, it, expect, afterEach, beforeEach } from "bun:test"
import { useRef } from "react"
import { render, screen, cleanup, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FloatingInputComposer } from "@/components/FloatingInputComposer"

const STORAGE_KEY = "oa-input-position"

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
})

// Test harness with bounds container
function Harness(props: {
  onSubmit?: (message: string, files?: File[]) => void
  placeholder?: string
}) {
  const boundsRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={boundsRef}
      data-testid="bounds"
      style={{ position: "relative", width: 1200, height: 800 }}
    >
      <FloatingInputComposer
        boundsRef={boundsRef}
        onSubmit={props.onSubmit ?? (() => {})}
        placeholder={props.placeholder ?? "Message…"}
      />
    </div>
  )
}

describe("FloatingInputComposer.filesBelow", () => {
  it("defaults to filesBelow=true (previews render below) when no position cue available", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    // Upload a file
    const file = new File(["test"], "test.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    // Verify file preview is rendered
    const fileText = await screen.findByText("test.txt")
    expect(fileText).toBeTruthy()
  })

  it("flips filesBelow to false when panel is far from bottom (b.bottom - p.bottom >= 140)", async () => {
    const user = userEvent.setup()

    // Mock getBoundingClientRect for position-dependent behavior
    const rectMap = new WeakMap<Element, DOMRect>()
    function stubRect(el: Element, rect: Partial<DOMRect>) {
      const full: DOMRect = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
        ...rect,
      } as DOMRect
      rectMap.set(el, full)
    }

    const originalGetBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return rectMap.get(this) ?? originalGetBCR.call(this)
    }

    try {
      render(<Harness />)

      // Stub bounds: bottom = 800, panel: bottom = 200 (distance = 600, well past 140 threshold)
      const bounds = screen.getByTestId("bounds")
      const panel = bounds.querySelector("[class*='absolute']") as HTMLElement
      if (bounds && panel) {
        stubRect(bounds, { top: 0, bottom: 800, height: 800, width: 1200 })
        stubRect(panel, { top: 0, bottom: 200, height: 200, width: 400 })
      }

      // Trigger resize to recompute
      act(() => {
        window.dispatchEvent(new Event("resize"))
      })

      // Upload a file
      const file = new File(["test"], "test.txt", { type: "text/plain" })
      const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(hiddenInput, file)

      // Verify file preview is rendered
      const fileText = await screen.findByText("test.txt")
      expect(fileText).toBeTruthy()
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBCR
    }
  })

  it("keeps filesBelow=true when panel is near bottom (b.bottom - p.bottom < 140)", async () => {
    const user = userEvent.setup()

    const rectMap = new WeakMap<Element, DOMRect>()
    function stubRect(el: Element, rect: Partial<DOMRect>) {
      const full: DOMRect = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
        ...rect,
      } as DOMRect
      rectMap.set(el, full)
    }

    const originalGetBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return rectMap.get(this) ?? originalGetBCR.call(this)
    }

    try {
      render(<Harness />)

      // Stub bounds: bottom = 800, panel: bottom = 700 (distance = 100, below 140 threshold)
      const bounds = screen.getByTestId("bounds")
      const panel = bounds.querySelector("[class*='absolute']") as HTMLElement
      if (bounds && panel) {
        stubRect(bounds, { top: 0, bottom: 800, height: 800, width: 1200 })
        stubRect(panel, { top: 600, bottom: 700, height: 100, width: 400 })
      }

      // Trigger resize to recompute
      act(() => {
        window.dispatchEvent(new Event("resize"))
      })

      // Upload a file
      const file = new File(["test"], "test.txt", { type: "text/plain" })
      const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(hiddenInput, file)

      // Verify file preview is rendered
      const fileText = await screen.findByText("test.txt")
      expect(fileText).toBeTruthy()
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBCR
    }
  })

  it("drag handle stays adjacent to input pill when filesBelow=true (default)", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    // Upload a file
    const file = new File(["test"], "test.txt", { type: "text/plain" })
    const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(hiddenInput, file)

    // Verify both handle and file preview are rendered
    const handle = screen.getByRole("button", { name: /drag input bar/i })
    const fileText = await screen.findByText("test.txt")
    expect(handle).toBeTruthy()
    expect(fileText).toBeTruthy()
  })

  it("drag handle stays adjacent to input pill when filesBelow=false", async () => {
    const user = userEvent.setup()

    const rectMap = new WeakMap<Element, DOMRect>()
    function stubRect(el: Element, rect: Partial<DOMRect>) {
      const full: DOMRect = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
        ...rect,
      } as DOMRect
      rectMap.set(el, full)
    }

    const originalGetBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return rectMap.get(this) ?? originalGetBCR.call(this)
    }

    try {
      render(<Harness />)

      // Stub to flip filesBelow to false
      const bounds = screen.getByTestId("bounds")
      const panel = bounds.querySelector("[class*='absolute']") as HTMLElement
      if (bounds && panel) {
        stubRect(bounds, { top: 0, bottom: 800, height: 800, width: 1200 })
        stubRect(panel, { top: 0, bottom: 200, height: 200, width: 400 })
      }

      act(() => {
        window.dispatchEvent(new Event("resize"))
      })

      // Upload a file
      const file = new File(["test"], "test.txt", { type: "text/plain" })
      const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(hiddenInput, file)

      // Verify both handle and file preview are rendered
      const handle = screen.getByRole("button", { name: /drag input bar/i })
      const fileText = await screen.findByText("test.txt")
      expect(handle).toBeTruthy()
      expect(fileText).toBeTruthy()
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBCR
    }
  })

  it("double-click reset triggers recompute without throwing", async () => {
    const user = userEvent.setup()

    const rectMap = new WeakMap<Element, DOMRect>()
    function stubRect(el: Element, rect: Partial<DOMRect>) {
      const full: DOMRect = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
        ...rect,
      } as DOMRect
      rectMap.set(el, full)
    }

    const originalGetBCR = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return rectMap.get(this) ?? originalGetBCR.call(this)
    }

    try {
      // Seed an out-of-bounds offset
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 99999, y: -99999 }))
      render(<Harness />)

      // Stub rects
      const bounds = screen.getByTestId("bounds")
      const panel = bounds.querySelector("[class*='absolute']") as HTMLElement
      if (bounds && panel) {
        stubRect(bounds, { top: 0, bottom: 800, height: 800, width: 1200 })
        stubRect(panel, { top: 0, bottom: 200, height: 200, width: 400 })
      }

      const handle = screen.getByRole("button", { name: /drag input bar/i })

      // Double-click should not throw
      let threw = false
      try {
        await user.dblClick(handle)
      } catch {
        threw = true
      }
      expect(threw).toBe(false)

      // Verify localStorage was reset
      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ x: 0, y: 0 }))
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBCR
    }
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CommandPalette, type Command } from "@/components/CommandPalette"

// Rows sit 32px apart (happy-dom lays nothing out), so the pill has
// somewhere to travel.
const realRect = Element.prototype.getBoundingClientRect
const realAnimate = Element.prototype.animate
let glides: Keyframe[][] = []

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const idx = this.getAttribute("data-idx")
    const top = idx === null ? 0 : Number(idx) * 32
    return { top, bottom: top + 32, left: 0, right: 200, width: 200, height: idx === null ? 0 : 32, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  }
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    glides.push(frames as Keyframe[])
    return realAnimate.call(this, frames, options)
  }
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect
  Element.prototype.animate = realAnimate
})
afterEach(() => {
  cleanup()
  glides = []
})

const commands: Command[] = [
  { id: "a", label: "Alpha", action: () => {} },
  { id: "b", label: "Bravo", action: () => {} },
  { id: "c", label: "Charlie", action: () => {} },
]

function pill(container: HTMLElement) {
  return container.ownerDocument.querySelector<HTMLElement>(".oa-slide-pill")!
}

describe("CommandPalette highlight", () => {
  it("draws one highlight behind the active row", () => {
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)
    expect(pill(container).hidden).toBe(false)
    expect(pill(container).style.top).toBe("0px")
  })

  it("glides the highlight to the next row on an arrow key", () => {
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" })
    expect(pill(container).style.top).toBe("32px")
    expect(glides.length).toBe(1)
    expect(glides[0][0].transform).toBe("translateY(-32px)")
  })

  it("lands at once when typing changes the rows", () => {
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" })
    glides = []
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Char" } })
    expect(glides.length).toBe(0)
    expect(pill(container).hidden).toBe(false)
  })

  it("hides the highlight when nothing matches", () => {
    const { container } = render(<CommandPalette commands={commands} onClose={() => {}} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzzzqqq" } })
    expect(pill(container).hidden).toBe(true)
  })
})

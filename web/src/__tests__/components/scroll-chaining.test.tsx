import { describe, it, expect, afterEach, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { render, cleanup } from "@testing-library/react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Sheet, SheetContent } from "@/components/ui/sheet"

afterEach(cleanup)

// Mock lucide-react icons to avoid SVG issues in Happy DOM
mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

const indexCss = readFileSync(
  fileURLToPath(new URL("../../index.css", import.meta.url)),
  "utf8"
)

// ---------------------------------------------------------------------------
// Global CSS contract — index.css
//
// Nested content scrollers must CHAIN to their parent when they bottom out
// (good scroll-through UX on desktop + mobile). The document edge must stay
// LOCKED so the webview never rubber-bands.
// ---------------------------------------------------------------------------

describe("scroll chaining — global CSS contract", () => {
  it("internal scrollers use overscroll-behavior: auto (chain to parent)", () => {
    // Grab the rule block that targets the overflow utility selectors.
    const block = indexCss.match(
      /\.overflow-auto[\s\S]*?\.overflow-scroll\s*\{([\s\S]*?)\}/
    )
    expect(block).not.toBeNull()
    expect(block?.[1]).toContain("overscroll-behavior: auto")
    // Must NOT trap scroll on every internal scroller anymore.
    expect(block?.[1]).not.toContain("overscroll-behavior: none")
    expect(block?.[1]).not.toContain("overscroll-behavior: contain")
  })

  it("locks the document edge against rubber-band on html/body", () => {
    const block = indexCss.match(/html,\s*\n?\s*body\s*\{([\s\S]*?)\}/)
    expect(block).not.toBeNull()
    expect(block?.[1]).toContain("overflow: hidden")
    expect(block?.[1]).toContain("overscroll-behavior: none")
  })
})

// ---------------------------------------------------------------------------
// Overlay scrollers must TRAP scroll (overscroll-contain) so scrolling a
// modal/sheet never leaks to the page behind it.
// ---------------------------------------------------------------------------

describe("scroll chaining — overlays trap scroll", () => {
  it("DialogContent scroller uses overscroll-contain", () => {
    render(
      <Dialog open>
        <DialogContent>content</DialogContent>
      </Dialog>
    )
    const content = document.querySelector('[data-slot="dialog-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toContain("overscroll-contain")
    expect(content?.className).toContain("overflow-y-auto")
  })

  it("SheetContent scroller uses overscroll-contain", () => {
    render(
      <Sheet open>
        <SheetContent>content</SheetContent>
      </Sheet>
    )
    const content = document.querySelector('[data-slot="sheet-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toContain("overscroll-contain")
    expect(content?.className).toContain("overflow-y-auto")
  })
})

// ---------------------------------------------------------------------------
// Component-source contract — anchored popovers/menus also trap scroll.
// These render via portals/positioners that are awkward to mount in jsdom,
// so we assert the className contract at the source level instead.
// ---------------------------------------------------------------------------

describe("scroll chaining — anchored popovers trap scroll (source)", () => {
  const cases: Array<[string, string]> = [
    ["dropdown-menu", "src/components/ui/dropdown-menu.tsx"],
    ["select", "src/components/ui/select.tsx"],
    ["input-bar suggestions", "src/components/InputBar.suggestions.tsx"],
    ["command palette", "src/components/CommandPalette.tsx"],
    ["todos popover", "src/components/TodosPopover.tsx"],
    ["multi-select", "src/components/settings/MultiSelect.tsx"],
    ["model combobox", "src/components/settings/AgentForm/ModelCombobox.tsx"],
  ]

  for (const [name, rel] of cases) {
    it(`${name} popover scroller declares overscroll-contain`, () => {
      const src = readFileSync(
        fileURLToPath(new URL(`../../../${rel}`, import.meta.url)),
        "utf8"
      )
      expect(src).toContain("overscroll-contain")
    })
  }
})

// ---------------------------------------------------------------------------
// Embedded content scrollers must NOT trap scroll — they should chain.
// ---------------------------------------------------------------------------

describe("scroll chaining — embedded content chains (source)", () => {
  it("CodingWorkspacePanel inline diff/graph viewers do not use overscroll-contain", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../../components/CodingWorkspacePanel.tsx", import.meta.url)
      ),
      "utf8"
    )
    expect(src).not.toContain("overscroll-contain")
  })
})

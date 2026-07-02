/**
 * Tests for ``components/ui/sidebar-item.tsx``.
 *
 * The big behavioural change here was the ``^N`` shorthand expansion
 * inside ``renderKbd()``: a caret prefix means "the platform's primary
 * modifier" and renders as ``Ctrl+N`` on Windows/Linux or ``⌘N`` on
 * macOS (see ``lib/keyboard-shortcut.ts``). These tests run under
 * happy-dom, which reports an unrecognised platform, so ``formatShortcut``
 * falls back to the ``Ctrl+`` label — the assertions below hold for that
 * default environment.
 *
 * Other surface we lock in:
 *
 *   - Expanded mode renders the label *and* the kbd hint.
 *   - Collapsed mode renders neither label nor kbd (icon only).
 *   - ``rightSlot`` overrides the kbd hint when both are passed.
 *   - ``title`` defaults to ``label (Ctrl+N)`` when both label and
 *     kbd are present (so hover tooltips show the expanded form).
 *   - ``aria-current="page"`` is applied iff ``active``.
 *   - A literal kbd string like ``"Alt+P"`` is rendered as-is (no
 *     mangling).
 */
import { describe, it, expect, afterEach } from "bun:test"
import { render, cleanup, screen } from "@testing-library/react"
import { SidebarItem } from "@/components/ui/sidebar-item"
import { Home } from "lucide-react"

afterEach(cleanup)

describe("SidebarItem — renderKbd shorthand", () => {
  it("expands ^N to literal 'Ctrl+N' in the kbd badge", () => {
    render(<SidebarItem Icon={Home} label="New" kbd="^N" />)
    expect(screen.getByText("Ctrl+N")).toBeTruthy()
    expect(screen.queryByText("^N")).toBeNull()
  })

  it("expands ^B to 'Ctrl+B'", () => {
    render(<SidebarItem Icon={Home} label="Toggle" kbd="^B" />)
    expect(screen.getByText("Ctrl+B")).toBeTruthy()
  })

  it("preserves case-sensitivity (^a → Ctrl+a, not Ctrl+A)", () => {
    // ``renderKbd`` does NOT uppercase — it concatenates verbatim.
    // The convention is to pass uppercase, but we don't enforce it.
    render(<SidebarItem Icon={Home} label="X" kbd="^a" />)
    expect(screen.getByText("Ctrl+a")).toBeTruthy()
  })

  it("renders literal multi-token kbd unchanged", () => {
    // No leading caret → no transformation. Use case: existing
    // 'Ctrl+Shift+P' style hints can be passed verbatim.
    render(<SidebarItem Icon={Home} label="Find" kbd="Ctrl+Shift+P" />)
    expect(screen.getByText("Ctrl+Shift+P")).toBeTruthy()
  })

  it("renders 'Alt+P' verbatim (caret only at start triggers expansion)", () => {
    render(<SidebarItem Icon={Home} label="Find" kbd="Alt+P" />)
    expect(screen.getByText("Alt+P")).toBeTruthy()
  })

  it("an empty kbd is not rendered as a badge", () => {
    // Currently the component renders nothing if kbd is falsy. The
    // shorthand path requires ``startsWith('^')``, which empty strings
    // do not satisfy.
    const { container } = render(<SidebarItem Icon={Home} label="X" kbd="" />)
    expect(container.querySelector("kbd")).toBeNull()
  })

  it("^^ (double caret) expands to 'Ctrl+^' — slice(1) only strips one char", () => {
    // Pinning current semantics. Probably no caller does this, but it
    // documents the (predictable) behaviour.
    render(<SidebarItem Icon={Home} label="X" kbd="^^" />)
    expect(screen.getByText("Ctrl+^")).toBeTruthy()
  })

  it("^ alone expands to 'Ctrl+' (empty suffix)", () => {
    render(<SidebarItem Icon={Home} label="X" kbd="^" />)
    expect(screen.getByText("Ctrl+")).toBeTruthy()
  })
})

describe("SidebarItem — expanded vs collapsed", () => {
  it("expanded mode shows the label", () => {
    render(<SidebarItem Icon={Home} label="Dashboard" />)
    expect(screen.getByText("Dashboard")).toBeTruthy()
  })

  it("collapsed mode hides the label and the kbd badge", () => {
    const { container } = render(
      <SidebarItem Icon={Home} label="Dashboard" kbd="^N" collapsed />,
    )
    expect(screen.queryByText("Dashboard")).toBeNull()
    expect(screen.queryByText("Ctrl+N")).toBeNull()
    expect(container.querySelector("kbd")).toBeNull()
  })

  it("collapsed mode shows only the icon", () => {
    render(
      <SidebarItem Icon={Home} label="Dashboard" collapsed />,
    )
    // Label and kbd should be hidden
    expect(screen.queryByText("Dashboard")).toBeNull()
    // Icon should still be visible via the button role
    expect(screen.getByRole("button")).toBeTruthy()
  })

  it("expanded mode shows label and kbd", () => {
    render(<SidebarItem Icon={Home} label="Dashboard" kbd="^N" />)
    expect(screen.getByText("Dashboard")).toBeTruthy()
    expect(screen.getByText("Ctrl+N")).toBeTruthy()
  })
})

describe("SidebarItem — rightSlot override", () => {
  it("rightSlot wins over kbd when both are present", () => {
    render(
      <SidebarItem
        Icon={Home}
        label="Items"
        kbd="^N"
        rightSlot={<span data-testid="badge">42</span>}
      />,
    )
    expect(screen.getByTestId("badge")).toBeTruthy()
    // kbd must NOT render alongside rightSlot — the slot replaces it.
    expect(screen.queryByText("Ctrl+N")).toBeNull()
  })

  it("rightSlot is also suppressed in collapsed mode", () => {
    render(
      <SidebarItem
        Icon={Home}
        label="Items"
        collapsed
        rightSlot={<span data-testid="badge">42</span>}
      />,
    )
    expect(screen.queryByTestId("badge")).toBeNull()
  })
})

describe("SidebarItem — title tooltip", () => {
  it("title defaults to 'label (Ctrl+N)' when kbd is shorthand", () => {
    const { container } = render(<SidebarItem Icon={Home} label="New" kbd="^N" />)
    const btn = container.querySelector("button")!
    expect(btn.getAttribute("title")).toBe("New (Ctrl+N)")
  })

  it("title defaults to 'label (Ctrl+Shift+P)' for literal kbd", () => {
    const { container } = render(
      <SidebarItem Icon={Home} label="Find" kbd="Ctrl+Shift+P" />,
    )
    expect(container.querySelector("button")!.getAttribute("title")).toBe(
      "Find (Ctrl+Shift+P)",
    )
  })

  it("title falls back to bare label when no kbd is provided", () => {
    const { container } = render(<SidebarItem Icon={Home} label="Just Label" />)
    expect(container.querySelector("button")!.getAttribute("title")).toBe(
      "Just Label",
    )
  })

  it("explicit title prop overrides the auto-generated one", () => {
    const { container } = render(
      <SidebarItem Icon={Home} label="X" kbd="^N" title="Custom tooltip" />,
    )
    expect(container.querySelector("button")!.getAttribute("title")).toBe(
      "Custom tooltip",
    )
  })
})

describe("SidebarItem — active state", () => {
  it("sets aria-current='page' when active", () => {
    const { container } = render(<SidebarItem Icon={Home} label="X" active />)
    const btn = container.querySelector("button")!
    expect(btn.getAttribute("aria-current")).toBe("page")
  })

  it("does not set aria-current when not active", () => {
    const { container } = render(<SidebarItem Icon={Home} label="X" />)
    const btn = container.querySelector("button")!
    expect(btn.getAttribute("aria-current")).toBeNull()
  })

  it("marks active state with aria-current", () => {
    const { container } = render(<SidebarItem Icon={Home} label="X" active />)
    const btn = container.querySelector("button")!
    expect(btn.getAttribute("aria-current")).toBe("page")
  })
})

describe("SidebarItem — onClick", () => {
  it("forwards click events to the handler", async () => {
    let clicked = 0
    const onClick = () => {
      clicked++
    }
    const { container } = render(
      <SidebarItem Icon={Home} label="X" onClick={onClick} />,
    )
    const btn = container.querySelector("button")!
    btn.click()
    expect(clicked).toBe(1)
  })

  it("does not crash without an onClick handler", () => {
    const { container } = render(<SidebarItem Icon={Home} label="X" />)
    const btn = container.querySelector("button")!
    // Should not throw.
    expect(() => btn.click()).not.toThrow()
  })
})

import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

function getHeader(title: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("[title]"))
    .find((node) => node.getAttribute("title") === title)
  if (!match) throw new Error(`Header with title="${title}" not found`)
  return match
}

describe("ToolCall - LSP operation display", () => {
  it("shows the definition path and position", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "go_to_definition",
          path: "app/services/lsp/manager.py",
          line: 668,
          character: 9,
        })}
      />,
    )

    expect(getHeader("LSP: Definition at app/services/lsp/manager.py:668:9")).toBeTruthy()
  })

  it("shows the references path and position", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "find_references",
          path: "web/src/components/ToolResult.tsx",
          line: 857,
          character: 10,
        })}
      />,
    )

    expect(getHeader("LSP: References at web/src/components/ToolResult.tsx:857:10")).toBeTruthy()
  })

  it("shows the document symbol source", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "document_symbol",
          path: "app/agent/tools/builtin/lsp.py",
        })}
      />,
    )

    expect(getHeader("LSP: Symbols in app/agent/tools/builtin/lsp.py")).toBeTruthy()
  })

  it("shows the hover position", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "hover",
          path: "app/services/lsp/manager.py",
          line: 668,
          character: 9,
        })}
      />,
    )

    expect(getHeader("LSP: Hover at app/services/lsp/manager.py:668:9")).toBeTruthy()
  })

  it("shows the implementations path and position", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "find_implementations",
          path: "app/services/lsp/manager.py",
          line: 668,
          character: 9,
        })}
      />,
    )

    expect(getHeader("LSP: Implementations at app/services/lsp/manager.py:668:9")).toBeTruthy()
  })

  it("shows the document symbol kind filter", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "document_symbol",
          path: "app/agent/tools/builtin/lsp.py",
          kind: "function",
        })}
      />,
    )

    expect(getHeader("LSP: Function symbols in app/agent/tools/builtin/lsp.py")).toBeTruthy()
  })

  it("shows the workspace symbol query and representative source", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "workspace_symbol",
          path: "app/services/lsp/manager.py",
          query: "navigation",
        })}
      />,
    )

    expect(
      getHeader('LSP: Workspace symbols "navigation" via app/services/lsp/manager.py'),
    ).toBeTruthy()
  })

  it("shows the workspace symbol kind filter alongside the query", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "workspace_symbol",
          path: "app/services/lsp/manager.py",
          query: "navigation",
          kind: "class",
        })}
      />,
    )

    expect(
      getHeader('LSP: Workspace symbols "navigation" (class) via app/services/lsp/manager.py'),
    ).toBeTruthy()
  })

  it("renders operation-specific results after expansion", () => {
    render(
      <ToolCall
        name="lsp"
        args={JSON.stringify({
          operation: "find_references",
          path: "app/services/lsp/manager.py",
          line: 668,
          character: 9,
        })}
        done
        result={"app/services/lsp/manager.py:668:9\ntests/services/test_lsp_navigation.py:52:23"}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand lsp details" }))

    expect(screen.getByText("2 references")).toBeTruthy()
    expect(screen.getByText("app/services/lsp/manager.py")).toBeTruthy()
    expect(screen.getByText("668:9")).toBeTruthy()
    expect(screen.getByText("tests/services/test_lsp_navigation.py")).toBeTruthy()
    expect(screen.getByText("52:23")).toBeTruthy()
  })
})

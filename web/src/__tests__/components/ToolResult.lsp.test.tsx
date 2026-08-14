import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolResult } from "@/components/ToolResult"

afterEach(cleanup)

describe("ToolResult - LSP navigation", () => {
  it.each([
    ["go_to_definition", "2 definitions"],
    ["find_references", "2 references"],
    ["document_symbol", "2 document symbols"],
    ["workspace_symbol", "2 workspace symbols"],
  ])("renders %s locations with an operation-specific count", (operation, count) => {
    render(
      <ToolResult
        toolName="lsp"
        operation={operation}
        result={"Answer | app/main.py:12:5\napp/lib.py:3:1"}
      />,
    )

    expect(screen.getByText(count)).toBeTruthy()
    expect(screen.getByText("Answer")).toBeTruthy()
    expect(screen.getByText("app/main.py")).toBeTruthy()
    expect(screen.getByText("12:5")).toBeTruthy()
    expect(screen.getByText("app/lib.py")).toBeTruthy()
    expect(screen.getByText("3:1")).toBeTruthy()
  })

  it("renders the source excerpt attached to a location", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="find_references"
        result={"app/main.py:12:5 | from app.answer import answer\napp/main.py:20:9 | print(answer())"}
      />,
    )

    expect(screen.getByText("2 references")).toBeTruthy()
    expect(screen.getByText("from app.answer import answer")).toBeTruthy()
    expect(screen.getByText("print(answer())")).toBeTruthy()
    expect(screen.getAllByText("app/main.py").length).toBe(2)
  })

  it("keeps pipes inside a source excerpt intact", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="find_references"
        result={"Answer (class) [read] | app/main.py:12:5 | flags = A | B"}
      />,
    )

    expect(screen.getByText("Answer (class) [read]")).toBeTruthy()
    expect(screen.getByText("flags = A | B")).toBeTruthy()
  })

  it("renders the truncation note without counting it as a location", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="workspace_symbol"
        result={"Answer (class) [exact] | app/main.py:12:5\n… truncated: showing 50 of 62 results (12 omitted)."}
      />,
    )

    expect(screen.getByText("1 workspace symbol")).toBeTruthy()
    expect(screen.getByText("… truncated: showing 50 of 62 results (12 omitted).")).toBeTruthy()
  })

  it("labels find_implementations results", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="find_implementations"
        result={"a.py:1:1\nb.py:2:1\nc.py:3:1"}
      />,
    )

    expect(screen.getByText("3 implementations")).toBeTruthy()
  })

  it.each([
    ["go_to_definition", "No definition found."],
    ["find_implementations", "No implementations found."],
    ["find_references", "No references found."],
    ["document_symbol", "No symbols found."],
    ["workspace_symbol", "No symbols found."],
  ])("renders the %s empty state without inventing a count", (operation, message) => {
    render(
      <ToolResult
        toolName="lsp"
        operation={operation}
        result="No results."
      />,
    )

    expect(screen.getByText(message)).toBeTruthy()
  })

  it("renders hover text as-is, not as a location list", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="hover"
        result={"def foo() -> int"}
      />,
    )

    expect(screen.getByText("def foo() -> int")).toBeTruthy()
  })

  it("renders the hover empty state", () => {
    render(
      <ToolResult
        toolName="lsp"
        operation="hover"
        result="No hover information available."
      />,
    )

    expect(screen.getByText("No hover information available.")).toBeTruthy()
  })
})

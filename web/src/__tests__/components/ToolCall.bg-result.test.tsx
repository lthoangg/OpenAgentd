import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

describe("ToolCall — bg results", () => {
  it("keeps the copy action when no background processes are running", () => {
    render(
      <ToolCall
        name="bg"
        args='{"action":"list"}'
        done
        result="No background processes running."
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand bg details" }))

    expect(screen.getByText("No background processes")).toBeTruthy()
    expect(screen.queryByText("No background processes running.")).toBeNull()
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy()
  })

  it("keeps the copy action for status-only background results", () => {
    render(
      <ToolCall
        name="bg"
        args='{"action":"status","pid":1234}'
        done
        result={"PID 1234: running\nCommand: bun dev\nBuffered lines: 4"}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand bg details" }))

    expect(screen.getByText("pid 1234")).toBeTruthy()
    expect(screen.getByText("running").closest('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("info")
    expect(screen.getByText("4 new lines")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy()
  })

  it("uses the process header and copy button instead of a generic result wrapper", () => {
    render(
      <ToolCall
        name="bg"
        args='{"action":"wait","pid":1234}'
        done
        result={"PID 1234: exited (code 0)\nFinal output:\nserver ready"}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Expand bg details" }))

    expect(screen.queryByText("result")).toBeNull()
    expect(screen.getByText("pid 1234")).toBeTruthy()
    expect(screen.getByText("exited (code 0)").closest('[data-slot="chip"]')?.getAttribute("data-tone")).toBe("neutral")
    // With a status shown there is no separate "output" detail
    expect(screen.queryByText("output")).toBeNull()
    expect(screen.getByText(/server ready/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy()
  })
})

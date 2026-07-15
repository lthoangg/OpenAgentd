import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolCall } from "@/components/ToolCall"

afterEach(cleanup)

describe("ToolCall — bg results", () => {
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
    expect(screen.getByText("PID 1234 output")).toBeTruthy()
    expect(screen.getByText("exited (code 0)")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy result" })).toBeTruthy()
  })
})

/**
 * On a phone the @ and / suggestion rows are 44pt, in body size, the name
 * over its folder or description (mockup J3).
 */
import { afterEach, describe, expect, it, mock } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))
mock.module("@/hooks/use-is-phone", () => ({ useIsPhone: () => true }))

import { InputComposer } from "@/components/InputComposer"

afterEach(cleanup)

describe("InputComposer suggestions on a phone", () => {
  it("draws @ rows 44pt, the file name over its folder", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={[{ path: "src/api.ts", name: "api.ts", type: "file" }]} />)
    await user.type(screen.getByLabelText("Message input"), "@")
    const list = screen.getByRole("listbox", { name: "Reference workspace file" })
    const row = list.querySelector<HTMLElement>('[role="option"]')!
    expect(row.className).toContain("min-h-11")
    const lines = row.querySelectorAll("span.block")
    expect(lines[0].textContent).toBe("api.ts")
    expect(lines[1].textContent).toBe("src/")
  })
})

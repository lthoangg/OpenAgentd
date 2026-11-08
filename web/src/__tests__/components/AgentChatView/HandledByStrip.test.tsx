import { describe, it, expect, afterEach, mock } from "bun:test"
import "@testing-library/jest-dom"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HandledByStrip } from "@/components/AgentChatView/HandledByStrip"

afterEach(cleanup)

const sender = { session_id: "app-session", workspace: "/r/app", title: "Orders API" }

describe("HandledByStrip", () => {
  it("names the agent handling the session and opens its session", async () => {
    const onOpen = mock(() => {})
    render(<HandledByStrip sentFrom={sender} onOpenSession={onOpen} />)

    const strip = screen.getByRole("status")
    expect(strip).toHaveTextContent("Handled by the agent in app")
    expect(strip).toHaveTextContent("Orders API")
    await userEvent.setup().click(screen.getByRole("button", { name: "Open the session handling this, in app" }))
    expect(onOpen).toHaveBeenCalledWith("app-session", "/r/app")
  })

  it("shows nothing for a session the user started", () => {
    const { container } = render(<HandledByStrip sentFrom={null} onOpenSession={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

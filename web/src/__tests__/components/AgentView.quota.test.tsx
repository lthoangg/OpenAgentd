import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from "bun:test"
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import { useUIStore } from "@/stores/useUIStore"
import type { ContentBlock } from "@/api/types"

const { stopAgent: realStopAgent, sendMessage: realSendMessage, setSessionRunSettings: realSetSessionRunSettings } = useAgentStore.getState()

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useAgentStore.setState({ sessionId: "quota-session" })
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  act(() => {
    useAgentStore.setState({
      sessionId: null,
      _workspace: null,
      stopAgent: realStopAgent,
      sendMessage: realSendMessage,
      setSessionRunSettings: realSetSessionRunSettings,
    })
  })
})

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

function makeQuotaBlock(
  id: string,
  model = "codex:gpt-5.4",
  message?: string,
  resetsAt = Math.floor(Date.now() / 1000) + 7200,
): ContentBlock {
  return {
    id,
    type: "provider_status",
    content: "",
    extra: {
      status: "waiting_quota",
      model,
      message,
      delay_seconds: 7202,
      retry_after: 7200,
      resets_at: resetsAt,
    },
  }
}

function makeUserBlock(id: string, content = "continue"): ContentBlock {
  return {
    id,
    type: "user",
    content,
  }
}

describe("AgentView — waiting_quota status rendering", () => {
  it("renders quota wait block, with the provider's message one Copy details away", async () => {
    const customMsg =
      "Provider quota exhausted for codex:gpt-5.4. Waiting 2h 00m for reset. Agent will automatically resume work. You can stop anytime."
    const writeText = mock(async (_text: unknown) => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true })
    render(
      <AgentView
        blocks={[makeQuotaBlock("q1", "codex:gpt-5.4", customMsg)]}
        currentBlocks={[]}
        isWorking={true}
      />
    )

    expect(screen.getByText("Waiting for quota reset")).toBeTruthy()
    expect(screen.getByText("2h 00m")).toBeTruthy()
    // No native hover title: the provider's own wording is a visible action.
    expect(document.querySelector("[title]")).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy details" })) })
    expect(writeText).toHaveBeenCalledWith(customMsg)
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()
  })

  it("renders default message when custom message is omitted, with Stop on the card", () => {
    const stopAgent = mock(async () => {})
    act(() => { useAgentStore.setState({ stopAgent }) })
    render(
      <AgentView
        blocks={[makeQuotaBlock("q2", "copilot:claude-sonnet-4")]}
        currentBlocks={[]}
        isWorking={true}
      />
    )

    expect(screen.getByText("Waiting for quota reset")).toBeTruthy()
    expect(screen.getByText("2h 00m")).toBeTruthy()
    expect(document.querySelector("[data-model-name]")?.textContent).toContain("claude-sonnet-4")
    expect(screen.getByText(/used up its provider quota.*Resumes automatically\./)).toBeTruthy()
    // Nothing to copy without the provider's message; no pinned-account choices either.
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Use Auto for this session" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Choose account…" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(stopAgent).toHaveBeenCalledTimes(1)
  })

  it("names the account when the status carries one", () => {
    const block = makeQuotaBlock("q-account", "codex:gpt-5.4")
    block.extra = { ...block.extra, credential_label: "Work" }
    render(<AgentView blocks={[block]} currentBlocks={[]} isWorking={true} />)

    expect(screen.getByText("Work")).toBeTruthy()
    expect(screen.getByText(/on account/)).toBeTruthy()
  })

  it("updates the countdown every minute", () => {
    const start = Date.now()
    const dateNow = spyOn(Date, "now").mockReturnValue(start)
    const nativeSetInterval = window.setInterval
    const nativeClearInterval = window.clearInterval
    let tick: (() => void) | undefined
    window.setInterval = ((callback: TimerHandler) => {
      tick = callback as () => void
      return 1
    }) as typeof window.setInterval
    window.clearInterval = (() => {}) as typeof window.clearInterval

    try {
      render(
        <AgentView
          blocks={[makeQuotaBlock("q-minute", "codex:gpt-5.4", undefined, start / 1000 + 7200)]}
          currentBlocks={[]}
          isWorking={true}
        />,
      )
      expect(screen.getByText("2h 00m")).toBeTruthy()

      dateNow.mockReturnValue(start + 60_000)
      act(() => tick?.())

      expect(screen.getByText("1h 59m")).toBeTruthy()
    } finally {
      window.setInterval = nativeSetInterval
      window.clearInterval = nativeClearInterval
      dateNow.mockRestore()
    }
  })

  it("restores the active quota wait after a page refresh", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 7200
    const firstRender = render(
      <AgentView
        blocks={[makeQuotaBlock("q3", "codex:gpt-5.4", undefined, resetAt)]}
        currentBlocks={[]}
        isWorking={true}
      />,
    )

    expect(screen.getByText("2h 00m")).toBeTruthy()
    firstRender.unmount()

    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={true}
      />,
    )

    expect(screen.getByText("Waiting for quota reset")).toBeTruthy()
    expect(screen.getByText("2h 00m")).toBeTruthy()
  })

  it("does not render historical quota wait when the turn is no longer active", () => {
    render(
      <AgentView
        blocks={[makeQuotaBlock("q-ended")]}
        currentBlocks={[]}
        isWorking={false}
      />,
    )

    expect(screen.queryByText("Waiting for quota reset")).toBeNull()
  })

  it("gives way to the reply dots once the quota has reset", () => {
    const start = Date.now()
    const dateNow = spyOn(Date, "now").mockReturnValue(start)
    const nativeSetTimeout = window.setTimeout
    let wake: (() => void) | undefined
    window.setTimeout = ((callback: TimerHandler, ms?: number) => {
      if (typeof ms === "number" && ms > 1000) wake = callback as () => void
      return nativeSetTimeout(() => {}, 0)
    }) as typeof window.setTimeout
    try {
      render(
        <AgentView
          blocks={[makeUserBlock("u1")]}
          currentBlocks={[makeQuotaBlock("q-reset", "codex:gpt-5.4", undefined, start / 1000 + 90)]}
          isWorking={true}
        />,
      )
      expect(screen.getByText("Waiting for quota reset")).toBeTruthy()

      dateNow.mockReturnValue(start + 91_000)
      act(() => wake?.())

      expect(screen.queryByText("Waiting for quota reset")).toBeNull()
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
      expect(screen.getByRole("status", { name: "Agent is preparing a response" })).toBeTruthy()
    } finally {
      window.setTimeout = nativeSetTimeout
      dateNow.mockRestore()
    }
  })

  it("does not keep the quota wait notice after chat activity resumes", () => {
    render(
      <AgentView
        blocks={[makeQuotaBlock("q-old"), makeUserBlock("u-next")]}
        currentBlocks={[]}
        isWorking={true}
      />,
    )

    expect(screen.queryByText("Waiting for quota reset")).toBeNull()
  })

  it("clears stored quota wait when no active wait is present", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 7200
    localStorage.setItem(
      "openagentd:quota-wait:quota-session",
      JSON.stringify({ model: "codex:gpt-5.4", resetsAt: resetAt }),
    )

    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
      />,
    )

    expect(screen.queryByText("Waiting for quota reset")).toBeNull()
    expect(localStorage.getItem("openagentd:quota-wait:quota-session")).toBeNull()
  })
})

describe("AgentView — waiting for the pinned account", () => {
  const PINNED_MESSAGE =
    "Personal is pinned for this session and hit its usage limit. Waiting 2h 00m for it to reset. Use Auto to continue on another account now, or stop at any time."

  function makePinnedBlock(id: string, message: string | undefined = PINNED_MESSAGE): ContentBlock {
    const block = makeQuotaBlock(id, "codex:gpt-5.4", message)
    block.extra = { ...block.extra, status: "waiting_credential" }
    return block
  }

  it("is the same card, naming the account and the model, with every way forward", () => {
    render(<AgentView blocks={[makePinnedBlock("p1")]} currentBlocks={[]} isWorking={true} />)

    expect(screen.getByText("Waiting for the pinned account")).toBeTruthy()
    expect(screen.getByText("2h 00m")).toBeTruthy()
    expect(screen.getByText("Personal")).toBeTruthy()
    expect(screen.getByText("gpt-5.4").closest("[data-model-name]")?.className).toContain("font-mono")
    for (const name of ["Use Auto for this session", "Choose account…", "Stop", "Copy details"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy()
    }
    expect(screen.queryByText("Provider status updated.")).toBeNull()
  })

  it("opens the run picker from Choose account…", () => {
    const openRunPicker = mock((_focus?: unknown) => {})
    const original = useUIStore.getState().openRunPicker
    act(() => { useUIStore.setState({ openRunPicker }) })
    try {
      render(<AgentView blocks={[makePinnedBlock("p2")]} currentBlocks={[]} isWorking={true} />)
      fireEvent.click(screen.getByRole("button", { name: "Choose account…" }))
      expect(openRunPicker).toHaveBeenCalledWith("model")
    } finally {
      act(() => { useUIStore.setState({ openRunPicker: original }) })
    }
  })

  it("drops the pin, stops, and continues on Auto", async () => {
    const setSessionRunSettings = mock(async (_settings: unknown) => true)
    const stopAgent = mock(async (_options?: unknown) => {})
    const sendMessage = mock(async (..._args: unknown[]) => true)
    act(() => { useAgentStore.setState({ setSessionRunSettings, stopAgent, sendMessage, _workspace: "/work" }) })
    render(<AgentView blocks={[makePinnedBlock("p3")]} currentBlocks={[]} isWorking={true} />)

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use Auto for this session" })) })

    expect(setSessionRunSettings).toHaveBeenCalledWith({ credentialId: null })
    expect(stopAgent).toHaveBeenCalledWith({ keepGoal: true })
    expect(sendMessage).toHaveBeenCalledWith("Continue.", undefined, { workspace: "/work" })
    act(() => { useAgentStore.setState({ _workspace: null }) })
  })

  it("says 'the pinned account' when the status does not name it", () => {
    render(<AgentView blocks={[makePinnedBlock("p4", "Waiting.")]} currentBlocks={[]} isWorking={true} />)

    expect(screen.getByText(/The pinned account hit its usage limit/)).toBeTruthy()
  })

  it("is still the pinned card, with its ways forward, after a page refresh", () => {
    const first = render(<AgentView blocks={[makePinnedBlock("p5")]} currentBlocks={[]} isWorking={true} />)
    expect(screen.getByText("Waiting for the pinned account")).toBeTruthy()
    first.unmount()

    render(<AgentView blocks={[]} currentBlocks={[]} isWorking={true} />)

    expect(screen.getByText("Waiting for the pinned account")).toBeTruthy()
    expect(screen.getByText("Personal")).toBeTruthy()
    for (const name of ["Use Auto for this session", "Choose account…", "Stop", "Copy details"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy()
    }
  })
})

import { describe, it, expect, afterEach, mock } from "bun:test"
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom"
import { AgentView } from "@/components/AgentView"
import { useAgentStore } from "@/stores/useAgentStore"
import { useDisplayPrefsStore } from "@/stores/useDisplayPrefsStore"
import { useSettingsStore } from "@/stores/useSettingsStore"
import { useUIStore } from "@/stores/useUIStore"
import type { ContentBlock } from "@/api/types"

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: "detailed" })
})

mock.module("lucide-react", () => new Proxy({}, { get: () => () => null }))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: "text", content }
}

function makeUserBlock(id: string): ContentBlock {
  return { id, type: "user", content: "hello" }
}

// ── isError / lastError props ─────────────────────────────────────────────────

describe("AgentView — error state", () => {
  it("renders nothing special when isError is false", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "some output")]}
        currentBlocks={[]}
        isWorking={false}
        isError={false}
        lastError="should not appear"
      />
    )
    expect(screen.queryByText("should not appear")).toBeNull()
  })

  it("renders error box when isError=true and lastError is set", () => {
    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError="LLM provider unavailable"
      />
    )
    expect(screen.getByText("LLM provider unavailable")).toBeTruthy()
  })

  it("does not render error box when isError=true but lastError is null", () => {
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError={null}
      />
    )
    // No red error box rendered
    const errorBox = container.querySelector("[class*='color-error']")
    expect(errorBox).toBeNull()
  })

  it("does not render error box when isError is undefined", () => {
    render(
      <AgentView
        blocks={[]}
        currentBlocks={[]}
        isWorking={false}
        lastError="ghost error"
      />
    )
    expect(screen.queryByText("ghost error")).toBeNull()
  })

  it("shows error box alongside existing blocks", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "partial output")]}
        currentBlocks={[]}
        isWorking={false}
        isError={true}
        lastError="Rate limit hit"
      />
    )
    expect(screen.getByText("partial output")).toBeTruthy()
    expect(screen.getByText("Rate limit hit")).toBeTruthy()
  })

  it("does not show bouncing dots when isError=true", () => {
    // Bouncing dots appear when isWorking=true with only user blocks.
    // Error state should never show dots.
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[makeUserBlock("u1")]}
        isWorking={false}
        isError={true}
        lastError="Something went wrong"
      />
    )
    const dots = container.querySelectorAll('[aria-label="Agent is preparing a response"] > span')
    expect(dots.length).toBe(0)
  })
})

// ── isError prop is optional — no regressions ─────────────────────────────────

describe("AgentView — omitting isError/lastError props", () => {
  it("renders normally without isError or lastError props", () => {
    render(
      <AgentView
        blocks={[makeTextBlock("b1", "hello world")]}
        currentBlocks={[]}
        isWorking={false}
      />
    )
    expect(screen.getByText("hello world")).toBeTruthy()
  })

  it("shows working dots without isError prop", () => {
    const { container } = render(
      <AgentView
        blocks={[]}
        currentBlocks={[makeUserBlock("u1")]}
        isWorking={true}
      />
    )
    const dots = container.querySelectorAll('[aria-label="Agent is preparing a response"] > span')
    expect(dots.length).toBe(3)
  })
})

// ── the way forward from an error ─────────────────────────────────────────────

function providerError(id: string, message: string): ContentBlock {
  return {
    id,
    type: "provider_status",
    content: message,
    extra: { type: "provider_status", status: "error", title: "Provider Error", message, category: "provider" },
    timestamp: new Date("2026-01-01T10:00:00Z"),
  }
}

const ENDED_IN_ERROR: ContentBlock[] = [
  { id: "m1", type: "user", content: "first prompt" },
  { id: "a1", type: "text", content: "first answer" },
  { id: "m2", type: "user", content: "second prompt" },
  { id: "a2", type: "text", content: "partial answer" },
  providerError("e2", "Rate limit exceeded"),
]

describe("AgentView — error card actions", () => {
  it("offers Retry and Switch model on the error a turn ended with", () => {
    const onRetry = mock(() => {})
    const onSwitchModel = mock(() => {})
    render(<AgentView blocks={ENDED_IN_ERROR} currentBlocks={[]} isWorking={false} onRetry={onRetry} onSwitchModel={onSwitchModel} />)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }))
    expect(onSwitchModel).toHaveBeenCalledTimes(1)
  })

  it("leaves an error the agent recovered from without actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      providerError("e1", "Rate limit exceeded"),
      { id: "a1", type: "text", content: "answer after the fallback model" },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.getByText("Rate limit exceeded")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("leaves errors in earlier turns without actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      providerError("e1", "Rate limit exceeded"),
      { id: "m2", type: "user", content: "try again" },
      { id: "a2", type: "text", content: "answer" },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("offers no actions while the turn is open", () => {
    render(<AgentView blocks={ENDED_IN_ERROR} currentBlocks={[]} isWorking={false} isTurnOpen onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("offers no Retry when a subagent's report came in after the prompt, even folded in reader mode", () => {
    useDisplayPrefsStore.setState({ transcriptStyle: "reader" })
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      { id: "d1", type: "tool", content: "", toolName: "delegate", toolDone: true },
      { id: "r1", type: "user", content: "report", extra: { from_agent: "explorer#1" } },
      providerError("e1", "Rate limit exceeded"),
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    expect(screen.getByRole("button", { name: "Switch model" })).toBeTruthy()
  })

  it("shows a turn error once when the transcript already carries it", () => {
    render(
      <AgentView
        blocks={ENDED_IN_ERROR}
        currentBlocks={[]}
        isWorking={false}
        isError
        lastError="Rate limit exceeded"
        onRetry={() => {}}
        onSwitchModel={() => {}}
      />
    )

    expect(screen.getAllByText("Rate limit exceeded")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
  })

  it("gives a failure the transcript does not show its own card, with the same actions", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "first prompt" },
      { id: "a1", type: "text", content: "first answer" },
      { id: "m2", type: "user", content: "second prompt" },
    ]
    const onRetry = mock(() => {})
    render(
      <AgentView
        blocks={blocks}
        currentBlocks={[]}
        isWorking={false}
        isError
        lastError="Agent crashed"
        onRetry={onRetry}
        onSwitchModel={() => {}}
      />
    )

    expect(screen.getByText("Agent crashed")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Switch model" })).toBeTruthy()
  })
})

describe("AgentView — provider retry notice", () => {
  function retrying(extra: Record<string, unknown>): ContentBlock {
    return {
      id: "r1",
      type: "provider_status",
      content: "",
      extra: { status: "retrying", model: "openai:gpt", attempt: 3, delay_seconds: 4.2, error_type: "RemoteProtocolError", ...extra },
    }
  }

  it("counts attempts without a budget while waiting for the network", () => {
    render(<AgentView blocks={[]} currentBlocks={[retrying({ max_attempts: null })]} isWorking />)
    const notice = screen.getByRole("status")
    expect(notice.textContent).toBe("Retrying openai:gpt · attempt 3 · in 4.2 sRemoteProtocolError")
    expect(screen.getByText("RemoteProtocolError").closest("[data-slot=chip]")).toBeTruthy()
  })

  it("shows the budget when the retries have one", () => {
    render(<AgentView blocks={[]} currentBlocks={[retrying({ max_attempts: 5, error_type: "HTTPStatusError", status_code: 503 })]} isWorking />)
    expect(screen.getByRole("status").textContent).toBe("Retrying openai:gpt · attempt 3/5 · in 4.2 s503 HTTPStatusError")
  })

  const notice = () => document.querySelector("[data-provider-retry]")
  const prompt: ContentBlock = { id: "u1", type: "user", content: "prompt" }

  it("goes away once the retried call answers", () => {
    const { rerender } = render(<AgentView blocks={[prompt]} currentBlocks={[retrying({ max_attempts: 5 })]} isWorking />)
    expect(notice()).toBeTruthy()

    rerender(
      <AgentView
        blocks={[prompt]}
        currentBlocks={[retrying({ max_attempts: 5 }), { id: "t1", type: "text", content: "Here is the answer" }]}
        isWorking
      />,
    )
    expect(notice()).toBeNull()
    expect(screen.getByText("Here is the answer")).toBeTruthy()
  })

  it("stays while blank chunks follow it, before the answer starts", () => {
    render(<AgentView blocks={[prompt]} currentBlocks={[retrying({}), { id: "t1", type: "text", content: "  " }]} isWorking />)
    expect(notice()).toBeTruthy()
  })

  it("goes away once the turn ends, even when it was the last thing said", () => {
    render(<AgentView blocks={[prompt, retrying({ max_attempts: 5 })]} currentBlocks={[]} isWorking={false} />)
    expect(notice()).toBeNull()
  })

  it("leaves only the error card when the retries run out", () => {
    const error: ContentBlock = {
      id: "e1",
      type: "provider_status",
      content: "Service unavailable",
      extra: { status: "exhausted", message: "Service unavailable", category: "provider" },
    }
    render(<AgentView blocks={[prompt, retrying({ max_attempts: 5 }), error]} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)
    expect(notice()).toBeNull()
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  })

  it("says the retries stopped in one line, with one error card after it", () => {
    // What the server sends: a bare `exhausted` mark, then the turn's error.
    const exhausted: ContentBlock = {
      id: "x1",
      type: "provider_status",
      content: "",
      extra: { type: "provider_status", status: "exhausted", model: "openai:gpt", max_attempts: 5, error_type: "HTTPStatusError", status_code: 503, message: null },
    }
    const error: ContentBlock = {
      id: "e1",
      type: "provider_status",
      content: "Provider returned 503",
      extra: { status: "error", title: "Provider Unavailable", message: "Provider returned 503", category: "provider" },
    }
    render(<AgentView blocks={[prompt, retrying({ max_attempts: 5 }), exhausted, error]} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)

    expect(document.querySelector("[data-provider-exhausted]")?.textContent).toBe("Stopped retrying openai:gpt after 5 attempts503 HTTPStatusError")
    // One error card: no blank "Model error" card for the exhausted mark.
    expect(screen.queryByText("Model error")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Copy details" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
  })

  it("says which credential the turn moved to when one hits its limit", () => {
    const block: ContentBlock = {
      id: "s1",
      type: "provider_status",
      content: "",
      extra: {
        status: "switched_credential",
        model: "openai:gpt",
        error_type: "HTTPStatusError",
        status_code: 429,
        message: "Personal hit its usage limit (resets in 2h). Continuing on Work with the same model.",
      },
    }
    render(<AgentView blocks={[]} currentBlocks={[block]} isWorking />)
    // Words first: an info chip names the new account, the old one's reason follows.
    const chip = screen.getByText("Work").closest("[data-slot=chip]")
    expect(chip?.getAttribute("data-tone")).toBe("info")
    expect(chip?.textContent).toBe("Switched to account Work")
    expect(screen.getByText("Personal hit its usage limit (resets in 2h)")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("still says the account switched when the message has an unfamiliar shape", () => {
    const block: ContentBlock = {
      id: "s2",
      type: "provider_status",
      content: "",
      extra: { status: "switched_credential", model: "openai:gpt", message: "Moved to the next key." },
    }
    render(<AgentView blocks={[]} currentBlocks={[block]} isWorking />)

    expect(screen.getByText("Switched account").closest("[data-slot=chip]")?.getAttribute("data-tone")).toBe("info")
    expect(screen.getByText("Moved to the next key.")).toBeTruthy()
  })

  it("prefers the account the status names over the one in its message", () => {
    const block: ContentBlock = {
      id: "s3",
      type: "provider_status",
      content: "",
      extra: { status: "switched_credential", credential_label: "Home", message: "Personal was rate-limited. Continuing on Work with the same model." },
    }
    render(<AgentView blocks={[]} currentBlocks={[block]} isWorking />)

    expect(screen.getByText("Home")).toBeTruthy()
    expect(screen.queryByText("Work")).toBeNull()
  })
})

describe("AgentView — error card details and settings", () => {
  const detailed = (extra: Record<string, unknown>): ContentBlock => ({
    id: "e1",
    type: "provider_status",
    content: "Rate limit exceeded",
    extra: { status: "error", title: "Rate Limit Exceeded", message: "Rate limit exceeded", category: "provider", ...extra },
  })
  const ended = (error: ContentBlock): ContentBlock[] => [
    { id: "m1", type: "user", content: "prompt" },
    { id: "a1", type: "text", content: "partial" },
    error,
  ]

  it("copies the error with its code, status and model", async () => {
    const writeText = mock(async (_text: unknown) => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true })
    render(
      <AgentView
        blocks={ended(detailed({ code: "provider_rate_limit", status_code: 429, error_type: "HTTPStatusError", model: "openai:gpt-5" }))}
        currentBlocks={[]}
        isWorking={false}
      />,
    )

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy details" })) })

    expect(writeText).toHaveBeenCalledWith(
      "Rate Limit Exceeded\nRate limit exceeded\nCode: provider_rate_limit\nType: HTTPStatusError\nStatus: 429\nModel: openai:gpt-5",
    )
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()
  })

  it("lets an earlier error be copied too, without a way forward", () => {
    const blocks: ContentBlock[] = [
      { id: "m1", type: "user", content: "prompt" },
      detailed({}),
      { id: "a1", type: "text", content: "answer after the fallback" },
    ]
    render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} onRetry={() => {}} onSwitchModel={() => {}} />)

    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Provider settings" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Switch model" })).toBeNull()
  })

  it("opens Settings → Providers from the error a turn ended with", () => {
    const openSettings = mock((..._args: unknown[]) => {})
    const original = useSettingsStore.getState().openSettings
    act(() => { useSettingsStore.setState({ openSettings }) })
    try {
      render(<AgentView blocks={ended(detailed({}))} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)
      fireEvent.click(screen.getByRole("button", { name: "Provider settings" }))
      expect(openSettings).toHaveBeenCalledWith("providers")
    } finally {
      act(() => { useSettingsStore.setState({ openSettings: original }) })
    }
  })

  it("opens the run picker from Switch model when the host gives no handler", () => {
    const openRunPicker = mock((_focus?: unknown) => {})
    const original = useUIStore.getState().openRunPicker
    act(() => { useUIStore.setState({ openRunPicker }) })
    try {
      render(<AgentView blocks={ended(detailed({}))} currentBlocks={[]} isWorking={false} />)
      fireEvent.click(screen.getByRole("button", { name: "Switch model" }))
      expect(openRunPicker).toHaveBeenCalledWith("model")
    } finally {
      act(() => { useUIStore.setState({ openRunPicker: original }) })
    }
  })

  describe("on a session pinned to one account", () => {
    const pinned = (extra: Record<string, unknown>) => ended(detailed({
      title: "Provider Authentication Failed",
      message: "Work was rejected by the provider. Reconnect it in Settings → Providers, or use Auto for this session.",
      ...extra,
    }))

    it("offers Reconnect, Use Auto for this session and Choose account on a rejected account", () => {
      const openSettings = mock((..._args: unknown[]) => {})
      const openRunPicker = mock((_focus?: unknown) => {})
      const setSessionRunSettings = mock(async (_patch: unknown) => true)
      const onRetry = mock(() => {})
      const originals = { openSettings: useSettingsStore.getState().openSettings, openRunPicker: useUIStore.getState().openRunPicker, set: useAgentStore.getState().setSessionRunSettings }
      act(() => {
        useSettingsStore.setState({ openSettings })
        useUIStore.setState({ openRunPicker })
        useAgentStore.setState({ sessionCredentialId: "cred-work", setSessionRunSettings })
      })
      try {
        render(<AgentView blocks={pinned({ code: "provider_auth_failed" })} currentBlocks={[]} isWorking={false} onRetry={onRetry} />)

        fireEvent.click(screen.getByRole("button", { name: "Reconnect…" }))
        expect(openSettings).toHaveBeenCalledWith("providers")
        expect(screen.queryByRole("button", { name: "Provider settings" })).toBeNull()

        fireEvent.click(screen.getByRole("button", { name: "Choose account…" }))
        expect(openRunPicker).toHaveBeenCalledWith("model")
      } finally {
        act(() => {
          useSettingsStore.setState({ openSettings: originals.openSettings })
          useUIStore.setState({ openRunPicker: originals.openRunPicker })
          useAgentStore.setState({ sessionCredentialId: null, setSessionRunSettings: originals.set })
        })
      }
    })

    it("drops the pin and retries from Use Auto for this session", async () => {
      const setSessionRunSettings = mock(async (_patch: unknown) => true)
      const onRetry = mock(() => {})
      const original = useAgentStore.getState().setSessionRunSettings
      act(() => { useAgentStore.setState({ sessionCredentialId: "cred-work", setSessionRunSettings }) })
      try {
        render(<AgentView blocks={pinned({ code: "provider_auth_failed" })} currentBlocks={[]} isWorking={false} onRetry={onRetry} />)
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use Auto for this session" })) })
        expect(setSessionRunSettings).toHaveBeenCalledWith({ credentialId: null })
        expect(onRetry).toHaveBeenCalledTimes(1)
      } finally {
        act(() => { useAgentStore.setState({ sessionCredentialId: null, setSessionRunSettings: original }) })
      }
    })

    it("keeps the plain actions on a session that runs on Auto", () => {
      render(<AgentView blocks={pinned({ code: "provider_auth_failed" })} currentBlocks={[]} isWorking={false} onRetry={() => {}} />)
      expect(screen.getByRole("button", { name: "Provider settings" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Use Auto for this session" })).toBeNull()
    })
  })
})

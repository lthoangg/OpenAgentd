import { describe, expect, it } from "bun:test"

import { providerErrorDetails, switchedAccount, waitAccount } from "@/components/AgentView/provider-status"

describe("waitAccount — the account a quota wait names", () => {
  it("reads it from the pinned wait's message", () => {
    const message = "Personal is pinned for this session and hit its usage limit. Waiting 2h 00m for it to reset."
    expect(waitAccount({ status: "waiting_credential", message })).toBe("Personal")
  })

  it("keeps a label that has spaces whole", () => {
    const message = "Team key #2 is pinned for this session and hit its usage limit. Waiting 5m."
    expect(waitAccount({ status: "waiting_credential", message })).toBe("Team key #2")
  })

  it("prefers a credential_label on the status itself", () => {
    expect(waitAccount({ status: "waiting_quota", credential_label: "Work", message: "Quota used up." })).toBe("Work")
  })

  it("names none for an Auto wait that carries none", () => {
    expect(waitAccount({ status: "waiting_quota", message: "Provider quota exhausted for codex:gpt-5." })).toBeUndefined()
    expect(waitAccount(undefined)).toBeUndefined()
  })
})

describe("switchedAccount — where Auto moved the turn", () => {
  it("splits the message into the new account and why the old one was left", () => {
    expect(switchedAccount({ message: "Personal hit its usage limit (resets in 2h). Continuing on Work with the same model." })).toEqual({
      account: "Work",
      reason: "Personal hit its usage limit (resets in 2h)",
    })
  })

  it("reads the sentence for a credential the server could not name", () => {
    expect(switchedAccount({ message: "The credential in use was rate-limited. Continuing on Home with the same model." })).toEqual({
      account: "Home",
      reason: "The credential in use was rate-limited",
    })
  })

  it("falls back to the whole message, and names no account, for another shape", () => {
    expect(switchedAccount({ message: "Moved to the next key." })).toEqual({ account: undefined, reason: "Moved to the next key." })
    expect(switchedAccount(undefined)).toEqual({ account: undefined, reason: undefined })
  })
})

describe("providerErrorDetails — what Copy details hands over", () => {
  it("lists the title, the message, then whatever the error carries", () => {
    expect(providerErrorDetails({
      title: "Rate Limit Exceeded",
      message: "Slow down.",
      extra: { code: "provider_rate_limit", error_type: "HTTPStatusError", status_code: 429, model: "openai:gpt-5" },
    })).toBe("Rate Limit Exceeded\nSlow down.\nCode: provider_rate_limit\nType: HTTPStatusError\nStatus: 429\nModel: openai:gpt-5")
  })

  it("does not repeat a title the message already is, and skips empty fields", () => {
    expect(providerErrorDetails({ title: "Model error", message: "Model error", extra: { code: null, status_code: "" } })).toBe("Model error")
  })

  it("ends with the transport's own text, which the card itself never shows", () => {
    expect(providerErrorDetails({
      title: "openai:gpt-5 is unavailable",
      message: "It answered with an error 5 times in a row (HTTP 503).",
      extra: { code: "provider_unavailable", details: "Server error '503 Service Unavailable' for url 'https://api.openai.com/v1/responses'" },
    })).toBe("openai:gpt-5 is unavailable\nIt answered with an error 5 times in a row (HTTP 503).\nCode: provider_unavailable\nServer error '503 Service Unavailable' for url 'https://api.openai.com/v1/responses'")
  })
})

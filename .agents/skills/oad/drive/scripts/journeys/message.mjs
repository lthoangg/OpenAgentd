// Send a message in a new session and watch the reply stream in.
// Feature notes: ../../features/message.md
export default async function message({ page, expect, step, newSessionInDemo, send, run, history, sessionId, modelRequests }) {
  const text = `Hello from the drive at ${run} width`

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("type and send", async () => {
    await send(text)
    await expect(page.getByRole("main").getByText(text, { exact: true })).toBeVisible()
  })

  await step("the reply streams in", async () => {
    await expect(page.getByText(`Stub reply (chat): ${text}`)).toBeVisible()
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible() // the turn ended: Stop is gone
  })

  await step("the server stored the turn and the model was asked once", async () => {
    const lead = await history(sessionId())
    expect(lead.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(lead.messages[1].content).toBe(`Stub reply (chat): ${text}`)
    expect(lead.running).toBeFalsy()
    const asked = modelRequests().filter((r) => r.stream && r.answer[1] === `Stub reply (chat): ${text}`)
    expect(asked.map((r) => r.protocol)).toEqual(["chat"])
  })
}

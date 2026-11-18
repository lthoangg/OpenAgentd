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

  await step("a phone keyboard's Return picks the open slash command", async () => {
    const input = page.getByRole("textbox", { name: "Message input" })
    const menu = page.getByRole("listbox", { name: "Slash commands" })
    const session = page.url()
    await input.click()
    await input.pressSequentially("/new")
    await expect(menu.getByRole("option", { name: /^\/new / })).toBeVisible()
    // Android keyboards send Return as keyCode 229 with no Enter key event:
    // only a line-break input arrives. No browser key press produces that.
    await input.evaluate((el) => el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true })))
    await expect(page).not.toHaveURL(session) // /new ran: a new session
    await expect(menu).toBeHidden()
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("")
  })
}

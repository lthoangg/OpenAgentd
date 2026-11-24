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

  await step("an undo the server refuses: the toast says what could not be done, then why", async () => {
    await page.route("**/agent/commands", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The server is busy." }) }))
    const input = page.getByRole("textbox", { name: "Message input" })
    await input.click()
    await input.pressSequentially("/undo")
    await page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: /^\/undo / }).click()
    const toast = page.getByRole("alert").filter({ hasText: "Couldn't undo" })
    await expect(toast).toContainText("The server is busy.")
    await expect(toast).toBeInViewport()
    await page.unroute("**/agent/commands")
    // Nothing was undone, on the screen or on the server.
    await expect(page.getByText(`Stub reply (chat): ${text}`)).toBeVisible()
    expect((await history(sessionId())).messages.map((m) => m.role)).toEqual(["user", "assistant"])
    // The photo shows the toast once it has come in.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {}))))
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

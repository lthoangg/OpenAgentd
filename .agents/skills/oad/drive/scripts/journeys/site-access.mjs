// The agent may use a public site only after the user allows it: a card
// asks, Decline holds for the chat, Always allow is saved and shows in
// Settings → Browser. A browser cannot show a site: the tab says where
// sites open.
// Feature notes: ../../features/site-access.md

export default async function siteAccess({ page, expect, step, open, newSessionInDemo, send, run, api, modelRequests, phone }) {
  const id = String(run).toLowerCase().replace(/[^a-z0-9]/g, "")
  const declined = `shop-${id}.example`
  const allowed = `docs-${id}.example`
  const card = page.getByRole("radiogroup").filter({ hasText: "Always allow" })
  /** What the model was last told by a tool. */
  const lastToolResult = () => {
    const messages = modelRequests().at(-1).request.messages
    return String(messages.filter((m) => m.role === "tool").at(-1)?.content ?? "")
  }
  const finished = (n) => expect(page.getByText("Stub (chat): the tool finished.")).toHaveCount(n)
  const answer = async (label) => {
    // The radio itself is visually hidden; a user clicks its row.
    await card.getByText(label, { exact: true }).click()
    await expect(card.getByRole("radio", { name: new RegExp(`^${label}`) })).toBeChecked()
    await page.getByRole("button", { name: "Send", exact: true }).click()
  }
  const dialog = page.getByRole("dialog", { name: "Settings" })

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("the agent opens a site and a card asks the user first", async () => {
    await send(`drive:browser {"action": "open", "url": "https://www.${declined}/pricing"}`)
    await expect(card).toBeVisible()
    await expect(page.getByText(`Let the agent use ${declined}?`, { exact: false })).toBeVisible()
    await expect(card.getByRole("radio", { name: /^Allow once/ })).toBeVisible()
    await expect(card.getByRole("radio", { name: /^Decline/ })).toBeVisible()
    // Nothing was opened for it yet.
    const { previews } = await api("GET", "/preview")
    expect(previews.some((p) => String(p.origin).includes(declined))).toBe(false)
  })

  await step("Decline: the agent is told, and nothing is saved", async () => {
    await answer("Decline")
    await finished(1)
    expect(lastToolResult()).toBe(`The user declined: you may not use ${declined} in this chat.`)
    expect((await api("GET", "/browser/sites")).allowed).not.toContain(declined)
  })

  await step("asking again in the same chat is refused without a card", async () => {
    await send(`drive:browser {"action": "open", "url": "https://${declined}/"}`)
    await finished(2)
    expect(lastToolResult()).toContain(`The user declined to let the agent use ${declined} in this chat`)
    await expect(card).toHaveCount(0)
  })

  await step("Always allow saves the site", async () => {
    await send(`drive:browser {"action": "open", "url": "https://${allowed}/guide"}`)
    await expect(card).toBeVisible()
    await answer("Always allow")
    await finished(3)
    expect(lastToolResult()).toContain(`The user allowed ${allowed}; it is saved`)
    expect((await api("GET", "/browser/sites")).allowed).toContain(allowed)
  })

  await step("the agent opens it with no card; a browser says where sites open", async () => {
    await send(`drive:browser {"action": "open", "url": "https://${allowed}/guide"}`)
    await finished(4)
    expect(lastToolResult()).toContain(`Opening https://${allowed}/guide in the user's Browser tab`)
    await expect(card).toHaveCount(0)
    const { previews } = await api("GET", "/preview")
    expect(previews.some((p) => p.kind === "site" && p.origin === `https://${allowed}`)).toBe(true)
    if (phone) return // a phone opens a preview only from the tool row
    await expect(page.getByText("Public sites open in the desktop app")).toBeVisible()
    await expect(page.getByRole("button", { name: "Open in your browser" })).toBeVisible()
  })

  await step("in Chat the agent has browser too, and uses the saved site", async () => {
    await open("/")
    // On desktop "/" reopens the last session; New session shows the folder chip.
    await page.getByRole("button", { name: "New session", exact: true }).first().click()
    await page.getByRole("button", { name: /^Folder: .*Change folder$/ }).click()
    await page.getByRole("listbox", { name: "Folders" }).getByRole("option", { name: "Chat", exact: true }).click()
    await expect(page.getByRole("button", { name: /^Folder: Chat\. Change folder$/ })).toBeVisible()
    await send(`drive:browser {"action": "open", "url": "https://${allowed}/chat-${id}"}`)
    await finished(1)
    expect(lastToolResult()).toContain(`Opening https://${allowed}/chat-${id} in the user's Browser tab`)
    await expect(card).toHaveCount(0)
    const offered = modelRequests().at(-1).request.tools.map((t) => t.function.name)
    expect(offered).toContain("browser")
    expect(offered).not.toContain("preview")
  })

  await step("Settings → Browser lists the site, and removing it is saved", async () => {
    // The start page has the Settings button at every width.
    await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(dialog.getByRole("searchbox", { name: "Search settings" })).toBeVisible()
    await dialog.getByRole("searchbox", { name: "Search settings" }).fill("allowed sites")
    await dialog.getByRole("list", { name: "Search results" }).getByRole("button", { name: "Allowed sites, in Browser" }).click()
    await expect(dialog.getByRole("heading", { name: "Browser", level: 1 })).toBeVisible()
    await expect(dialog.getByText(allowed, { exact: true })).toBeVisible()
    // The profile is the desktop app's: a browser has no data to clear.
    await expect(dialog.getByText("Clear browsing data")).toHaveCount(0)
    await dialog.getByRole("button", { name: `Remove ${allowed}` }).click()
    await expect(dialog.getByText(allowed, { exact: true })).toHaveCount(0)
    expect((await api("GET", "/browser/sites")).allowed).not.toContain(allowed)
  })
}

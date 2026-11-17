// Turn a free connector on from the gallery and use it in a session; start
// an account connector's sign-in and see where it would come back to.
// Feature notes: ../../features/connectors.md
export default async function connectors({ page, expect, step, open, phone, api, newSessionInDemo, send, run, history, sessionId }) {
  const dialog = page.getByRole("dialog", { name: "Settings" })
  const card = (name) => dialog.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) })

  const openConnectors = async () => {
    await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    // Desktop names the section with a count ("Connectors 2 connectors").
    // The row's name carries a status hint ("3 connectors", "1 needs sign-in").
    await dialog.getByRole("button", { name: /^Connectors\b/ }).click()
    await expect(dialog.getByRole("heading", { name: "Add a connector" })).toBeVisible()
  }

  await step("Settings → Connectors opens on the gallery", async () => {
    await openConnectors()
    await expect(dialog.getByRole("heading", { name: "Free · just turn on" })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Sign in with your account" })).toBeVisible()
    await expect(card("Notion").getByRole("button", { name: "Connect" })).toBeVisible()
  })

  await step("turn Context7 on with its switch: it connects with no account", async () => {
    // The other width may have turned it on already.
    const off = card("Context7").getByRole("switch", { name: "Turn off Context7" })
    if (await off.isVisible()) {
      await off.click()
      await expect(card("Context7").getByText("Off", { exact: true })).toBeVisible()
    }
    await card("Context7").getByRole("switch", { name: "Turn on Context7" }).click()
    await expect(card("Context7").getByText(/^Ready · \d+ tools$/)).toBeVisible({ timeout: 30_000 })
    const { servers } = await api("GET", "/mcp/servers")
    const c7 = servers.find((s) => s.name === "context7")
    expect(c7.state).toBe("ready")
    expect(c7.config.url).toBe("https://mcp.context7.com/mcp")
  })

  await step("an agent asks Context7 a library question in a session", async () => {
    await newSessionInDemo()
    const code = `const r = await tools.mcp({ action: "call", server: "context7", tool: "resolve-library-id", arguments: { libraryName: "react", query: "react hooks" } }); console.log("c7-${run}", /\\/[\\w.-]+\\/react/.test(r)); return r.slice(0, 80);`
    await send(`drive:script ${code}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible({ timeout: 30_000 })
    const lead = await history(sessionId())
    const call = lead.messages.find((m) => m.role === "tool")
    const result = await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)
    expect(result.content).toContain(`c7-${run} true`)
  })

  await step("Connect on Notion opens Notion's sign-in page", async () => {
    await openConnectors()
    const popup = page.waitForEvent("popup")
    await card("Notion").getByRole("button", { name: "Connect" }).click()
    const signIn = await popup
    await expect.poll(() => signIn.url(), { timeout: 20_000 }).toMatch(/^https:\/\/([a-z]+\.)?notion\.(com|so)\//)
    await expect(card("Notion").getByText("Waiting for sign-in in your browser…")).toBeVisible()
    // This browser is on the server's machine, so the code comes back to localhost.
    const status = await api("GET", "/mcp/servers/notion/oauth/status")
    expect(status.status).toBe("waiting")
    await signIn.close()
  })

  await step("Cancel ends the sign-in and Connect is back", async () => {
    await card("Notion").getByRole("button", { name: "Cancel" }).click()
    await expect(card("Notion").getByRole("button", { name: "Connect" })).toBeVisible({ timeout: 15_000 })
    const status = await api("GET", "/mcp/servers/notion/oauth/status")
    expect(status.status).toBe("failed")
  })

  await step("the page a relayed sign-in returns to says when a code is stale", async () => {
    await open(`/oauth-done.html?code=stale-${run}&state=nope`)
    await expect(page.getByRole("heading", { name: "Couldn't sign in to the connector" })).toBeVisible()
    await expect(page.getByText("This sign-in has expired or already finished. Start it again.")).toBeVisible()
    expect(new URL(page.url()).search).toBe("") // the code is gone from the address
  })
}

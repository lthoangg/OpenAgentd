// Turn a free connector on from the gallery and use it in a session; start
// an account connector's sign-in and see where it would come back to; see a
// hand-added MCP server listed apart and remove it; disconnect a connector
// and see it back in the gallery.
// Feature notes: ../../features/connectors.md
export default async function connectors({ page, expect, step, open, api, newSessionInDemo, send, run, history, sessionId }) {
  const dialog = page.getByRole("dialog", { name: "Settings" })
  // A gallery tile: a list item in "Add a connector" holding the name.
  const gallery = dialog.getByRole("region", { name: "Add a connector" })
  const tile = (name) => gallery.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) })
  // A connector you have: its row in "Connectors", named after it.
  const yours = dialog.getByRole("region", { name: "Connectors", exact: true })
  const row = (name) => yours.getByRole("listitem", { name, exact: true })
  // A server added by hand: its row in "MCP servers".
  const servers = dialog.getByRole("region", { name: "MCP servers" })
  const serverRow = (name) => servers.getByRole("listitem", { name, exact: true })
  // A row's "⋯" action: a menu with a mouse, an action sheet on touch.
  const rowAction = async (rowLocator, name, label) => {
    await rowLocator.getByRole("button", { name: `More actions for ${name}` }).click()
    await page.locator("[role=menuitem], [data-action-sheet-item]").filter({ hasText: label }).click()
  }
  const handAdded = `drive-tools-${run}`

  // Precondition: neither connector is added yet (the other width adds them).
  const remove = async (name) => {
    const { servers } = await api("GET", "/mcp/servers")
    if (servers.some((s) => s.name === name)) await api("DELETE", `/mcp/servers/${name}`)
  }

  const openConnectors = async () => {
    await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    // Desktop names the section with a count ("Connectors 2 connectors").
    // The row's name carries a status hint ("3 connectors", "1 needs sign-in").
    await dialog.getByRole("button", { name: /^Connectors\b/ }).click()
    await expect(dialog.getByRole("heading", { name: "Add a connector" })).toBeVisible()
  }

  await step("Settings → Connectors opens on the gallery, one search box above it", async () => {
    await remove("context7")
    await remove("notion")
    await remove(handAdded)
    await openConnectors()
    await expect(dialog.getByRole("searchbox", { name: "Search connectors…" })).toHaveCount(1)
    await expect(dialog.getByRole("textbox", { name: "Search the gallery" })).toHaveCount(0) // no second box for the gallery
    // The action says what a connector takes; no sections by sign-in kind.
    await expect(dialog.getByRole("heading", { name: "Free · just turn on" })).toHaveCount(0)
    await expect(tile("Notion").getByRole("button", { name: "Connect" })).toBeVisible()
    await expect(tile("Context7").getByRole("switch", { name: "Turn on Context7" })).toBeVisible()
  })

  await step("turn Context7 on with its switch: it moves to Connectors and connects with no account", async () => {
    await tile("Context7").getByRole("switch", { name: "Turn on Context7" }).click()
    await expect(row("Context7").getByText(/^Ready · \d+ tools$/)).toBeVisible({ timeout: 30_000 })
    await expect(tile("Context7")).toHaveCount(0) // listed once
    await expect(row("Context7").getByRole("switch", { name: "Turn off Context7" })).toBeVisible()
    const { servers } = await api("GET", "/mcp/servers")
    const c7 = servers.find((s) => s.name === "context7")
    expect(c7.state).toBe("ready")
    expect(c7.config.url).toBe("https://mcp.context7.com/mcp")
    expect(c7.gallery).toMatchObject({ id: "context7", name: "Context7" })
  })

  await step("the search box filters your connectors and the gallery together", async () => {
    await dialog.getByRole("searchbox", { name: "Search connectors…" }).fill("notion")
    await expect(yours).toHaveCount(0)
    await expect(tile("Notion")).toBeVisible()
    await dialog.getByRole("searchbox", { name: "Search connectors…" }).fill("")
    await expect(row("Context7")).toBeVisible()
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

  await step("Connect on Notion opens Notion's sign-in page; Notion waits under Connectors", async () => {
    await openConnectors()
    const popup = page.waitForEvent("popup")
    await tile("Notion").getByRole("button", { name: "Connect" }).click()
    const signIn = await popup
    await expect.poll(() => signIn.url(), { timeout: 20_000 }).toMatch(/^https:\/\/([a-z]+\.)?notion\.(com|so)\//)
    await expect(row("Notion").getByText("Waiting for sign-in in your browser…")).toBeVisible({ timeout: 15_000 })
    await expect(tile("Notion")).toHaveCount(0)
    // This browser is on the server's machine, so the code comes back to localhost.
    const status = await api("GET", "/mcp/servers/notion/oauth/status")
    expect(status.status).toBe("waiting")
    await signIn.close()
  })

  await step("Cancel ends the sign-in and Connect is back on its row", async () => {
    await row("Notion").getByRole("button", { name: "Cancel" }).click()
    await expect(row("Notion").getByRole("button", { name: "Connect" })).toBeVisible({ timeout: 15_000 })
    await expect(row("Notion").getByText("Needs sign-in")).toBeVisible()
    const status = await api("GET", "/mcp/servers/notion/oauth/status")
    expect(status.status).toBe("failed")
  })

  await step("in dark mode the page and its logos follow the theme", async () => {
    await page.emulateMedia({ colorScheme: "dark" })
    await openConnectors()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await expect(row("Notion")).toBeVisible()
    await page.emulateMedia({ colorScheme: "light" })
  })

  await step("a server added by hand is listed under MCP servers with what it runs, and Remove deletes it", async () => {
    await api("POST", "/mcp/servers", { name: handAdded, server: { transport: "stdio", command: "npx", args: ["-y", "drive-tools"], env: {}, enabled: false } })
    await openConnectors()
    await expect(serverRow(handAdded).getByText("npx -y drive-tools")).toBeVisible({ timeout: 15_000 })
    await expect(row(handAdded)).toHaveCount(0)
    await rowAction(serverRow(handAdded), handAdded, "Remove…")
    const confirm = page.getByRole("dialog", { name: `Remove “${handAdded}”?` })
    await confirm.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(serverRow(handAdded)).toHaveCount(0, { timeout: 15_000 })
    const { servers: left } = await api("GET", "/mcp/servers")
    expect(left.some((s) => s.name === handAdded)).toBe(false)
  })

  await step("Disconnect on Context7 removes it, and its tile is back in the gallery", async () => {
    await rowAction(row("Context7"), "Context7", "Disconnect…")
    const confirm = page.getByRole("dialog", { name: "Disconnect Context7?" })
    await confirm.getByRole("button", { name: "Disconnect", exact: true }).click()
    await expect(row("Context7")).toHaveCount(0, { timeout: 15_000 })
    await expect(tile("Context7").getByRole("switch", { name: "Turn on Context7" })).toBeVisible({ timeout: 15_000 })
  })

  await step("the page a relayed sign-in returns to says when a code is stale", async () => {
    await open(`/oauth-done.html?code=stale-${run}&state=nope`)
    await expect(page.getByRole("heading", { name: "Couldn't sign in to the connector" })).toBeVisible()
    await expect(page.getByText("This sign-in has expired or already finished. Start it again.")).toBeVisible()
    expect(new URL(page.url()).search).toBe("") // the code is gone from the address
  })
}

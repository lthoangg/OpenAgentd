// Sign in to an account connector from a browser that is NOT on the server's
// machine: the code comes back through the public callback page, which asks
// first, then hands it to this OpenAgentd's /oauth-done.html page.
// The backend sees the browser as remote because every API request carries
// X-Forwarded-For (as through a reverse proxy).
// Uses the published callback page; to try another one, start the backend with e.g.
//   DRIVE_SERVER_ENV="OPENAGENTD_MCP_OAUTH_CALLBACK=https://staging-account.openagentd.dev/oauth/callback"
// Feature notes: ../../features/connectors.md
export default async function connectorsRemote({ page, expect, step, open, api, run }) {
  await page.route("**/api/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "192.0.2.10" } }),
  )
  const dialog = page.getByRole("dialog", { name: "Settings" })
  const card = (name) => dialog.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) })
  let signIn
  let authUrl

  await step("Connect on Linear from another device opens Linear with the public return page", async () => {
    await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await dialog.getByRole("button", { name: /^Connectors\b/ }).click()
    const popup = page.waitForEvent("popup")
    await card("Linear").getByRole("button", { name: "Connect" }).click()
    signIn = await popup
    await expect.poll(() => signIn.url(), { timeout: 20_000 }).toMatch(/linear\.app\//)
    authUrl = new URL(signIn.url())
    // Linear may bounce through its login page; the original request names the redirect.
    const redirect = authUrl.searchParams.get("redirect_uri") ?? decodeURIComponent(signIn.url()).match(/redirect_uri=([^&]+)/)?.[1]
    // The relay page (…/oauth/callback), not the server's own listener (…:<port>/callback).
    expect(redirect).toMatch(/\/oauth\/callback$/)
    await expect(card("Linear").getByText("Waiting for sign-in in your browser…")).toBeVisible()
  })

  await step("the callback page names the OpenAgentd it sends the code to and waits for a click", async () => {
    const raw = decodeURIComponent(signIn.url())
    const state = authUrl.searchParams.get("state") ?? raw.match(/[?&]state=([^&]+)/)?.[1]
    const redirect = authUrl.searchParams.get("redirect_uri") ?? raw.match(/redirect_uri=([^&]+)/)?.[1]
    expect(state).toBeTruthy()
    // Stand in for Linear sending the user back with a (made-up) code. Linear
    // also names itself (`iss`, RFC 9207), and the server checks that it does.
    const { issuer } = await (await fetch("https://mcp.linear.app/.well-known/oauth-authorization-server")).json()
    await signIn.goto(`${redirect}?code=drive-${run}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`)
    await expect(signIn.getByRole("heading", { name: /Finish connecting/ })).toBeVisible()
    await expect(signIn.getByText(new URL(page.url()).origin)).toBeVisible()
    expect(signIn.url()).toContain("/oauth/callback") // nothing moved on by itself
  })

  await step("Continue hands the code to this server, which takes it to Linear", async () => {
    await signIn.getByRole("button", { name: "Continue" }).click()
    await expect.poll(() => signIn.url(), { timeout: 15_000 }).toContain("/oauth-done.html")
    // The made-up code reached Linear's token endpoint and was refused there:
    // the state matched, so this is not the "expired" answer.
    await expect(signIn.getByRole("heading", { name: "Couldn't sign in to Linear" })).toBeVisible({ timeout: 20_000 })
    await expect(signIn.getByText("This sign-in has expired or already finished. Start it again.")).toHaveCount(0)
    expect(new URL(signIn.url()).search).toBe("")
    const status = await api("GET", "/mcp/servers/linear/oauth/status")
    expect(status.status).toBe("failed")
    expect(status.error).toMatch(/token|code|grant/i)
    await signIn.close()
  })
}

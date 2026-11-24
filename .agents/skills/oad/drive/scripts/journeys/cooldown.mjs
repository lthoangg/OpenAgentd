// A provider with two keys: the first is rate-limited, the turn moves on to
// the second, and the first turns back to ready by itself when its cooldown
// ends, in the run picker and in Settings, with no reload.
// Feature notes: ../../features/cooldown.md
export default async function cooldown({ page, expect, step, phone, api, newSessionInDemo, send, open, run, modelUrl }) {
  const SECONDS = 6
  // The cooldown is Retry-After plus the backend's clock-skew buffer, and the
  // list is read again a second after it ends.
  const RECOVERY = { timeout: (SECONDS + 15) * 1000 }
  const limited = `Limited ${run}`
  const spare = `Spare ${run}`
  const chip = page.getByRole("button", { name: /^Model .*Change/ })
  const picker = page.getByRole("dialog", { name: "Model and thinking" })
  const accounts = picker.getByRole("radiogroup", { name: "9Router account" })
  const settings = page.getByRole("dialog", { name: "Settings" })
  const keys = settings.getByRole("list", { name: "9Router keys" })
  const keyRow = (label) => keys.getByRole("listitem").filter({ hasText: label })

  await step("two 9Router keys point at the stub", async () => {
    // Precondition: only this run's keys, the one the stub limits first.
    const { credentials } = await api("GET", "/settings/providers/router9/credentials")
    for (const c of credentials) await api("DELETE", `/settings/providers/router9/credentials/${c.id}`)
    const extra = { ROUTER9_BASE_URL: modelUrl }
    // The stub limits the key named drive-limited (see stub_model.py).
    const add = (label, key) => api("POST", "/settings/providers/router9/credentials", { label, extra, ...Object.fromEntries([["api_key", key]]) })
    await add(limited, ["drive", "limited"].join("-"))
    await add(spare, ["drive", "spare"].join("-"))
    await api("POST", "/settings/providers/router9/models", {})
    await newSessionInDemo()
  })

  await step("pick 9Router's stub: its page lists both keys", async () => {
    await chip.click()
    await picker.getByRole("searchbox", { name: "Search models" }).fill("router9:stub")
    if (phone) await picker.getByRole("listbox", { name: "Models" }).getByRole("option").first().click()
    else await page.keyboard.press("Enter")
    await expect(accounts.getByRole("radio")).toHaveCount(2)
    await expect(chip).toHaveAccessibleName(/^Model router9:stub/)
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
  })

  await step("the first key is rate-limited: the turn goes on with the second", async () => {
    await send(`drive:limit ${SECONDS} ${run}`)
    await expect(page.getByText(`Stub reply (chat): drive:limit ${SECONDS} ${run}`)).toBeVisible()
    // The chip names the account in use.
    await expect(chip).toHaveAccessibleName(new RegExp(`account ${spare}\\.`))
  })

  await step("the picker says the first key is cooling down", async () => {
    await send("/think")
    await expect(accounts.getByRole("radio", { name: new RegExp(limited) })).toContainText("Cooling down")
    await expect(accounts.getByRole("radio", { name: new RegExp(spare) })).not.toContainText("Cooling down")
  })

  await step("left open, the picker drops Cooling down when the cooldown ends", async () => {
    await expect(accounts.getByRole("radio", { name: new RegExp(limited) })).not.toContainText("Cooling down", RECOVERY)
  })

  await step("lock the session to the first key", async () => {
    await accounts.getByRole("radio", { name: new RegExp(limited) }).click()
    await expect(accounts.getByRole("radio", { name: new RegExp(limited) })).toHaveAttribute("aria-checked", "true")
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
  })

  await step("limited again: Settings shows the countdown", async () => {
    const again = `drive:limit ${SECONDS} again ${run}`
    await send(again)
    await expect(page.getByText(`Stub reply (chat): ${again}`)).toBeVisible()
    // A phone's Settings button is on the home screen, not in a session.
    if (phone) await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await settings.getByRole("button", { name: /^Models/ }).first().click()
    await settings.getByRole("button", { name: /^9Router/ }).click()
    await expect(keyRow(limited)).toContainText(/Rate-limited · resets in \d+s/)
    await expect(keyRow(spare)).toContainText("Ready")
  })

  await step("left open, Settings shows the first key Ready when the cooldown ends", async () => {
    await expect(keyRow(limited)).not.toContainText("Rate-limited", RECOVERY)
    await expect(keyRow(limited)).toContainText("Ready")
  })

  // DESIGN.md → Long lists are rows: the provider list is the one frame. A
  // text field keeps its own border (the element, or the box right around it).
  const models = settings.getByRole("button", { name: /^Models · \d+ available/ })
  const framed = () => settings.locator('[data-provider="router9"]').evaluate((row) => [...row.querySelectorAll("*")].filter((el) => el.classList.contains("border") && !el.matches("input, textarea, select") && !el.querySelector(":scope > input, :scope > textarea")).map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class")}`))

  await step("the open provider is rows in one frame: keys, then its models", async () => {
    await models.click()
    await expect(settings.getByRole("searchbox", { name: "Filter models…" })).toBeVisible()
    expect(await framed()).toEqual([])
    await keys.scrollIntoViewIfNeeded()
  })

  await step("the same rows in the dark theme", async () => {
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveClass(/(^| )dark( |$)/)
    await models.scrollIntoViewIfNeeded()
  })

  await step("back to the light theme", async () => {
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).not.toHaveClass(/(^| )dark( |$)/)
  })
}

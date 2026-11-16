// Find sessions in the sidebar: listed under their workspace, opened by a
// click, and found by search.
// Feature notes: ../../features/sidebar.md
export default async function sidebar({ page, expect, step, seedSession, open, phone, run, sessionId }) {
  const alpha = `Alpha notes ${run}`
  const bravo = `Bravo cleanup ${run}`
  await seedSession(alpha)
  const bravoId = await seedSession(bravo)
  const list = page.getByRole("complementary").first()

  await step("both sessions are listed under demo", async () => {
    await open("/")
    const expand = list.getByRole("button", { name: "Expand workspace demo" })
    await expand.or(list.getByRole("button", { name: "Collapse workspace demo" })).first().waitFor()
    if (await expand.isVisible()) await expand.click()
    await expect(list.getByRole("button", { name: alpha, exact: true })).toBeVisible()
    await expect(list.getByRole("button", { name: bravo, exact: true })).toBeVisible()
  })

  await step("a click opens the session", async () => {
    await list.getByRole("button", { name: alpha, exact: true }).click()
    await expect(page.getByText(`Stub reply (chat): ${alpha}`)).toBeVisible()
  })

  await step("search finds the other session", async () => {
    if (phone) await page.getByRole("button", { name: "Back to Sessions" }).click()
    await page.getByRole("button", { name: /^Search( sessions)?$/ }).click()
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("Bravo cleanup " + run)
    const results = page.getByRole("region", { name: "Search results" })
    await expect(results.getByRole("button", { name: new RegExp(`^${bravo}`) })).toBeVisible()
    await expect(results.getByRole("button", { name: new RegExp(`^${alpha}`) })).toHaveCount(0)
  })

  await step("the result opens the session it names", async () => {
    await page.getByRole("region", { name: "Search results" }).getByRole("button", { name: new RegExp(`^${bravo}`) }).click()
    await expect(page.getByText(`Stub reply (chat): ${bravo}`)).toBeVisible()
    expect(sessionId()).toBe(bravoId)
  })
}

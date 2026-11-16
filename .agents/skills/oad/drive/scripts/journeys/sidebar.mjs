// Find sessions in the sidebar: listed under their workspace, opened by a
// click, and found by search. Then act on a row from its menu: rename a
// session, and start a worktree from the workspace's menu.
// Feature notes: ../../features/sidebar.md
export default async function sidebar({ page, expect, step, seedSession, open, phone, run, sessionId, hold }) {
  const alpha = `Alpha notes ${run}`
  const bravo = `Bravo cleanup ${run}`
  await seedSession(alpha)
  const bravoId = await seedSession(bravo)
  const list = page.getByRole("complementary").first()

  /** Open the list with demo's sessions showing; the group may already be expanded. */
  const openList = async () => {
    await open("/")
    const expand = list.getByRole("button", { name: "Expand workspace demo" })
    await expand.or(list.getByRole("button", { name: "Collapse workspace demo" })).first().waitFor()
    if (await expand.isVisible()) await expand.click()
  }

  await step("both sessions are listed under demo", async () => {
    await openList()
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

  const renamed = `Renamed ${run}`
  await step("a session's menu renames it", async () => {
    if (phone) {
      await page.getByRole("button", { name: "Back to Sessions" }).click()
      await hold(list.getByRole("button", { name: alpha, exact: true }))
      await page.getByRole("dialog").getByRole("button", { name: "Rename", exact: true }).click()
    } else {
      await list.getByRole("button", { name: alpha, exact: true }).hover()
      await list.getByRole("button", { name: `More actions for ${alpha}`, exact: true }).click()
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    }
    const title = page.getByRole("textbox", { name: "Session title" })
    await title.fill(renamed)
    await title.press("Enter")
    await expect(list.getByRole("button", { name: renamed, exact: true })).toBeVisible()
    await expect(list.getByRole("button", { name: alpha, exact: true })).toHaveCount(0)
  })

  await step("the new name is still there after a reload", async () => {
    await openList()
    await expect(list.getByRole("button", { name: renamed, exact: true })).toBeVisible()
  })

  await step("the workspace's menu opens Create worktree", async () => {
    if (phone) {
      await hold(list.getByRole("button", { name: "Open workspace demo", exact: true }))
      await page.getByRole("dialog", { name: "demo", exact: true }).getByRole("button", { name: "Create worktree…" }).click()
    } else {
      await list.getByRole("button", { name: "Open workspace demo", exact: true }).hover()
      await list.getByRole("button", { name: "Actions for demo", exact: true }).click()
      await page.getByRole("menuitem", { name: "Create worktree…" }).click()
    }
    await expect(page.getByRole("dialog", { name: /worktree/i })).toBeVisible()
  })
}

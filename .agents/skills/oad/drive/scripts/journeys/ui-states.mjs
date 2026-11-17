// What a screen says when something fails or is still loading, and the
// shared confirm and action sheet (DESIGN.md → Rulebook 7 and 10): a folder
// list that failed, a workspace whose sessions could not be read, deleting
// a workspace group, and ✎'s sheet on a phone.
// Feature notes: ../../features/ui-states.md
export default async function uiStates({ page, expect, step, open, phone, run, newSessionInDemo, hold }) {
  /** Sessions on a phone, which reopens the last session at `/`. */
  const home = async () => {
    await open("/")
    if (!phone) return
    const back = page.getByRole("button", { name: "Back to Sessions" })
    const sessions = page.getByRole("heading", { name: "Sessions", level: 1 })
    await back.or(sessions).first().waitFor()
    if (await back.isVisible()) await back.click()
  }
  /** Wait for the page's finite animations (a toast or a sheet coming in), so the photo shows it settled. */
  const settled = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished)))
  const down = (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The server is busy." }) })

  await step("a folder list that fails to load says so, with Retry", async () => {
    // The picker needs a folder to start in: open demo first.
    await newSessionInDemo()
    await page.route("**/agent/workspace/tree", down)
    // A reload of the draft, as after the app was away: nothing cached to fall back on.
    await page.reload({ waitUntil: "load" })
    // A phone reopens on Sessions, whose list is where its folders are; a
    // desktop stays on the draft, whose folder chip has the picker.
    const where = phone ? page.getByRole("complementary").first() : page.getByRole("main")
    const says = phone ? "Couldn't load workspaces." : "Couldn't load folders."
    // The app retries a failed read a few times (about 7 s) before it says so.
    await expect(where.getByText(says)).toBeVisible({ timeout: 20_000 })
    await expect(where.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  })

  await step("Retry loads them", async () => {
    await page.unroute("**/agent/workspace/tree")
    const where = phone ? page.getByRole("complementary").first() : page.getByRole("main")
    await where.getByRole("button", { name: "Retry", exact: true }).click()
    await expect(page.getByText(/Couldn't load (folders|workspaces)\./)).toHaveCount(0)
  })

  await step("a workspace whose sessions cannot be read says so, not a blank draft", async () => {
    await page.route(/\/agent\/sessions\?/, down)
    await open("/")
    const list = page.getByRole("complementary").first()
    await list.getByRole("button", { name: "Open workspace demo", exact: true }).click()
    const toast = page.getByText("Couldn't open the last session")
    await expect(toast).toBeInViewport({ timeout: 20_000 })
    await settled()
    await page.unroute(/\/agent\/sessions\?/)
  })

  const group = `Group ${run}`
  await step("deleting a workspace group asks first, with Cancel", async () => {
    await home()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await dialog.getByRole("button", { name: "Workspaces", exact: true }).click()
    await dialog.getByRole("button", { name: "New group" }).click()
    await dialog.getByRole("textbox", { name: "Group name" }).fill(group)
    await dialog.getByRole("button", { name: "Create group" }).click()
    await dialog.getByRole("button", { name: `Delete group ${group}` }).click()
    const confirm = page.getByRole("alertdialog", { name: `Delete ${group}?` }).or(page.getByRole("dialog", { name: `Delete ${group}?` }))
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
    await expect(confirm.getByRole("button", { name: "Delete group", exact: true })).toBeVisible()
  })

  await step("Cancel keeps the group", async () => {
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Settings" }).getByText(group, { exact: true })).toBeVisible()
  })

  if (phone) {
    await step("holding ✎ opens a sheet of folders with a Cancel row", async () => {
      await home()
      await hold(page.getByRole("button", { name: "New session", exact: true }))
      const sheet = page.getByRole("dialog", { name: "New session in…" })
      await expect(sheet.getByRole("button", { name: /demo/ }).first()).toBeVisible()
      await expect(sheet.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 })
      await settled()
      // The release's click must not have closed it.
      await expect(sheet).toBeVisible()
    })

    await step("Cancel closes it", async () => {
      await page.getByRole("dialog", { name: "New session in…" }).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "New session in…" })).toHaveCount(0)
    })
  }
}

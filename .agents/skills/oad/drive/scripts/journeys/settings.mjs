// Find a setting by search, change it, and see it kept.
// Feature notes: ../../features/settings.md
export default async function settings({ page, expect, step, open, phone }) {
  const dialog = page.getByRole("dialog", { name: "Settings" })
  const openSettings = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(dialog.getByRole("searchbox", { name: "Search settings" })).toBeVisible()
  }

  await step("open Settings", async () => {
    await open("/")
    await openSettings()
  })

  await step("search lands on the setting it names", async () => {
    await dialog.getByRole("searchbox", { name: "Search settings" }).fill("text size")
    await dialog.getByRole("list", { name: "Search results" }).getByRole("button", { name: "Text size, in General" }).click()
    await expect(dialog.getByRole("heading", { name: "General", level: 1 })).toBeVisible()
    await expect(dialog.getByRole("radiogroup", { name: "Text size" })).toBeVisible()
  })

  await step("change the text size and the theme", async () => {
    const textPx = () => dialog.getByRole("radio", { name: "Large" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    const before = await textPx()
    await dialog.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Large" }).click()
    await expect(dialog.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Large" })).toBeChecked()
    await dialog.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/(^| )dark( |$)/)
    await expect(page.locator("html")).toHaveAttribute("data-text-size", "large")
    expect(await textPx()).toBeGreaterThan(before) // the text a user reads grew
  })

  await step("both are kept after a reload", async () => {
    await page.reload({ waitUntil: "load" })
    await expect(page.locator("html")).toHaveClass(/(^| )dark( |$)/)
    await openSettings()
    if (phone) await dialog.getByRole("button", { name: "General", exact: true }).click()
    await expect(dialog.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "Large" })).toBeChecked()
    await expect(dialog.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" })).toBeChecked()
  })
}

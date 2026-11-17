// The run picker's two pages: pick a model, then its thinking level on the
// model's own page. Keys on a desktop, taps on a phone.
// Feature notes: ../../features/run-picker.md
export default async function runPicker({ page, expect, step, phone, newSessionInDemo, send, run, modelRequests }) {
  const chip = page.getByRole("button", { name: /^Model .*Change/ })
  const picker = page.getByRole("dialog", { name: "Model and thinking" })
  const models = picker.getByRole("listbox", { name: "Models" })
  const levels = picker.getByRole("listbox", { name: "Thinking for anthropic:stub" })
  const anthropicStub = models.getByRole("option", { name: "stub", exact: true }) // Ollama's reads "stub default"

  await step("open the picker on the models, with no Reset or Make default", async () => {
    await newSessionInDemo()
    await chip.click()
    await expect(models).toBeVisible()
    await expect(picker.getByRole("button", { name: /Reset to default|Make default/ })).toHaveCount(0)
  })

  await step("pick the Anthropic stub: its levels open on a page of their own", async () => {
    if (phone) {
      await anthropicStub.click()
    } else {
      await picker.getByRole("searchbox", { name: "Search models" }).fill("anthropic:stub")
      await page.keyboard.press("Enter")
    }
    await expect(levels).toBeVisible()
    await expect(models).toHaveCount(0)
    await expect(levels.getByRole("option")).toHaveText([/^Default/, "Low", "Medium", "High"])
    await expect(chip).toHaveAccessibleName(/^Model anthropic:stub\. /)
  })

  await step("go back to the models, then open the page again", async () => {
    if (phone) {
      await picker.getByRole("button", { name: "Back to models (anthropic:stub)" }).click()
      await expect(models).toBeVisible()
      await anthropicStub.click()
    } else {
      await page.keyboard.press("ArrowLeft")
      await expect(models).toBeVisible()
      // The search and the highlight are as they were.
      await expect(picker.getByRole("searchbox", { name: "Search models" })).toHaveValue("anthropic:stub")
      await expect(models.locator("[data-highlighted]")).toHaveText(/^stub/)
      // The keys are back in the search (a frame after the page goes).
      await expect(picker.getByRole("searchbox", { name: "Search models" })).toBeFocused()
      await page.keyboard.press("ArrowRight")
    }
    await expect(levels).toBeVisible()
  })

  await step("pick High: the picker closes and the chip names it", async () => {
    if (phone) {
      await levels.getByRole("option", { name: "High" }).click()
    } else {
      await expect(levels).toBeFocused()
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown")
      await expect(levels.locator("[data-highlighted]")).toHaveText("High")
      await page.keyboard.press("Enter")
    }
    await expect(picker).toBeHidden()
    await expect(chip).toHaveAccessibleName(/^Model anthropic:stub, thinking High\. /)
  })

  await step("/think opens on the running model's levels", async () => {
    await send("/think")
    await expect(levels).toBeVisible()
    await expect(levels.getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
  })

  await step("the turn runs with the level picked", async () => {
    await send(`Think at ${run}`)
    await expect(page.getByText(`Stub reply (messages): Think at ${run}`)).toBeVisible()
    const turn = modelRequests().filter((r) => r.stream && r.protocol === "messages" && JSON.stringify(r.request.messages).includes(`Think at ${run}`))
    expect(turn.length).toBeGreaterThan(0)
    expect(turn[0].request.thinking?.type).toBe("enabled")
  })
}

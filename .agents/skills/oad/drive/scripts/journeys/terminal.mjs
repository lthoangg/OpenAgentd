// Run a command in the terminal of a session's workspace.
// Feature notes: ../../features/terminal.md
import { existsSync } from "node:fs"

export default async function terminal({ page, expect, step, seedSession, open, openInReviewPanel, run, demo }) {
  const id = await seedSession(`Terminal session ${run}`)
  const marker = `terminal-${run}-${Date.now()}.txt`

  let panel
  await step("open the terminal", async () => {
    await open(`/${id}`)
    panel = await openInReviewPanel("Terminal", (p) => p.getByRole("textbox", { name: "Terminal input" }))
    await expect(panel.locator(".xterm-rows")).toBeVisible()
  })

  await step("a command prints its result", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    // The shell computes 42, so the echoed command line alone cannot pass.
    await page.keyboard.type(`echo drive-$((40+2)) && touch ${marker}`)
    await page.keyboard.press("Enter")
    await expect(panel.locator(".xterm-rows")).toContainText("drive-42")
  })

  await step("it ran in the session's workspace", async () => {
    await expect.poll(() => existsSync(`${demo}/${marker}`)).toBe(true)
  })
}

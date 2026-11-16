// Have the agent change a file, then read the change in the Review panel.
// Feature notes: ../../features/review.md
import { execFileSync } from "node:child_process"

export default async function review({ page, expect, step, newSessionInDemo, send, openInReviewPanel, run, demo }) {
  const line = `export const greeting = "hi from ${run}"`

  await step("ask for a change", async () => {
    await newSessionInDemo()
    await send(`drive:shell printf '${line}\\n' > greeting.ts`)
    await expect(page.getByRole("button", { name: /^Expand shell details/ })).toBeVisible()
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
  })

  let panel
  await step("the Review panel lists the changed file", async () => {
    panel = await openInReviewPanel("Git", (p) => p.getByRole("tablist", { name: "Git view" }))
    await expect(panel.getByRole("list", { name: "Changed files" }).getByRole("button", { name: /diff for greeting\.ts/ })).toBeVisible()
  })

  await step("its diff shows the old and the new line", async () => {
    await panel.getByRole("button", { name: "Expand diff for greeting.ts" }).click()
    const file = panel.getByRole("list", { name: "Changed files" }).getByRole("listitem").filter({ hasText: "greeting.ts" })
    await expect(file).toContainText('export const greeting = "hello"')
    await expect(file).toContainText(line)
  })

  await step("git on disk agrees", async () => {
    const diff = execFileSync("git", ["-C", demo, "diff", "--", "greeting.ts"]).toString()
    expect(diff).toContain(`+${line}`)
    expect(diff).toContain('-export const greeting = "hello"')
  })
}

// Calls a `script` makes refresh the panels a direct call would: a nested
// patch shows in Git and a nested todo on the task board, with the panel
// already open and no reload, and the turn keeps one script row.
// Feature notes: ../../features/script.md
import { readFileSync } from "node:fs"

export default async function scriptEffects({ page, expect, step, phone, newSessionInDemo, send, openInReviewPanel, run, demo }) {
  const file = `nested-${run}.txt`
  const task = `task from a script ${run}`
  const finished = page.getByText("Stub (chat): the tool finished.")
  const scriptRows = page.getByRole("button", { name: /^(Expand|Collapse) script details/ })
  const folded = page.getByRole("button", { name: "1 script", exact: true })
  const fileRow = () => panel.getByRole("button", { name: new RegExp(`diff for ${file.replace(/\./g, "\\.")}`) })
  // A phone shows the Review panel over the chat: go back to send, then
  // return to the panel, which stays open behind the chat.
  const sendFromChat = async (text) => {
    if (phone) await page.getByRole("button", { name: "Back to Chat" }).click()
    await send(text)
  }
  const backToPanel = async () => {
    if (phone) await page.getByRole("banner").getByRole("button", { name: "Review panel", exact: true }).click()
  }

  let panel
  await step("open Git in the Review panel before the agent works", async () => {
    await newSessionInDemo()
    panel = await openInReviewPanel("Git", (p) => p.getByRole("tablist", { name: "Git view" }))
    await expect(panel.getByRole("tab", { name: /^Changes \(\d+\)$/ })).toBeVisible()
    await expect(fileRow()).toHaveCount(0)
  })

  await step("a script patches a file and Git lists it without a reload", async () => {
    await sendFromChat(`drive:script await tools.patch({ patch_text: "*** Begin Patch\\n*** Add File: ${file}\\n+from a script\\n*** End Patch" }); return "patched";`)
    await expect(finished).toHaveCount(1)
    await backToPanel()
    await expect(fileRow()).toBeVisible()
    expect(readFileSync(`${demo}/${file}`, "utf8")).toBe("from a script\n")
  })

  await step("the turn shows one script row and no patch row", async () => {
    if (phone) await page.getByRole("button", { name: "Back to Chat" }).click()
    await scriptRows.or(folded).first().waitFor()
    if (await folded.isVisible()) await folded.click()
    await expect(scriptRows).toHaveCount(1)
    await expect(page.getByRole("button", { name: /^(Expand|Collapse) patch details/ })).toHaveCount(0)
  })

  // Tasks live in the Review panel on desktop, and in a sheet from the
  // header's Tasks button on a phone.
  const tasksButton = page.getByRole("banner").getByRole("button", { name: /^Tasks($|,)/ })
  await step("open Tasks before the agent plans", async () => {
    if (phone) {
      await tasksButton.click()
      const sheet = page.getByRole("dialog", { name: "Tasks" })
      await expect(sheet.getByText("No tasks yet")).toBeVisible()
      await sheet.getByRole("button", { name: "Done" }).click()
    } else {
      panel = await openInReviewPanel("Tasks", (p) => p.getByText("No tasks yet"))
    }
  })

  await step("a script adds a task and the board shows it without a reload", async () => {
    await send(`drive:script await tools.todo({ actions: [{ action: "create", content: "${task}" }] }); return "added";`)
    await expect(finished).toHaveCount(2)
    if (phone) {
      // The header counts the open task before the sheet opens.
      await expect(tasksButton).toHaveAccessibleName("Tasks, 1 open")
      await tasksButton.click()
    }
    const board = phone ? page.getByRole("dialog", { name: "Tasks" }) : panel
    await expect(board.getByText(task, { exact: true })).toBeVisible()
  })
}

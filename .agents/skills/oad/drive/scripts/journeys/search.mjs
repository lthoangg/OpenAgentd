// A `grep` call's result card: the lines around a match, the count of
// matches, and the note when the result was cut at its limit.
// Feature notes: ../../features/search.md
import { writeFileSync } from "node:fs"

export default async function search({ page, expect, step, newSessionInDemo, send, run, demo, api, history, sessionId, modelRequests }) {
  const needle = `needle-${run}`
  const many = `many-${run}`
  // One match with neighbours to show, and a file with more matches than the second search asks for.
  writeFileSync(`${demo}/search-${run}.txt`, ["alpha", "beta", `the ${needle} line`, "gamma", "delta", "epsilon"].join("\n") + "\n")
  writeFileSync(`${demo}/many-${run}.txt`, Array.from({ length: 12 }, (_, i) => `${many} ${i + 1}`).join("\n") + "\n")

  const row = (state) => page.getByRole("button", { name: `${state} grep details` })
  // Simple detail folds a turn's work behind one line, "1 search"; Full shows the row at once.
  const folded = page.getByRole("button", { name: "1 search", exact: true })
  const openRow = async () => {
    await row("Expand").or(folded).last().waitFor()
    if (await folded.last().isVisible()) await folded.last().click()
    await row("Expand").last().click()
  }
  const lines = (kind) => page.locator(`li[data-line="${kind}"]`)

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("a search with context shows the match and the lines around it", async () => {
    await send(`drive:grep {"pattern": "${needle}", "context": 2}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
    await openRow()
    await expect(page.getByText("1 match", { exact: true })).toBeVisible()
    await expect(page.getByText(`search-${run}.txt:3: the ${needle} line`)).toBeVisible()
    await expect(page.getByText(`search-${run}.txt-1- alpha`, { exact: true })).toBeVisible()
    await expect(page.getByText(`search-${run}.txt-5- delta`, { exact: true })).toBeVisible()
    // The match is one row; its four neighbours are marked as context.
    await expect(lines("match")).toHaveCount(1)
    await expect(lines("context")).toHaveCount(4)
  })

  await step("the server stored the same lines and the model asked with context", async () => {
    const lead = await history(sessionId())
    const call = lead.messages.find((m) => m.role === "tool" && m.name === "grep")
    const result = call.result_omitted ? (await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)).content : call.content
    expect(result).toBe(
      [`search-${run}.txt-1- alpha`, `search-${run}.txt-2- beta`, `search-${run}.txt:3: the ${needle} line`, `search-${run}.txt-4- gamma`, `search-${run}.txt-5- delta`].join("\n"),
    )
    const asked = modelRequests().filter((r) => r.answer[0] === "grep" && r.answer[1].includes(needle))
    expect(asked).toHaveLength(1)
  })

  await step("a search cut at its limit says how many more matches there are and where", async () => {
    await send(`drive:grep {"pattern": "${many} ", "max_results": 3}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toHaveCount(2)
    await openRow()
    await expect(page.getByText("3 matches", { exact: true })).toBeVisible()
    await expect(
      page.getByText(`3 of 12 matching lines shown. The other 9 are in many-${run}.txt. Narrow the pattern, directory or include, or raise max_results.`, { exact: true }),
    ).toBeVisible()
  })

  await step("after a reload the cut search reads the same", async () => {
    await page.reload({ waitUntil: "load" })
    await openRow()
    await expect(page.getByText("3 matches", { exact: true })).toBeVisible()
    await expect(page.getByText(`3 of 12 matching lines shown. The other 9 are in many-${run}.txt.`, { exact: false })).toBeVisible()
  })
}

// A `script` tool call: the row's title and call count, the open row's code,
// nested calls and result, and the same row after a reload.
// Feature notes: ../../features/script.md
export default async function script({ page, expect, step, newSessionInDemo, send, run, api, history, sessionId, modelRequests }) {
  const marker = `script-${run}`
  const code = `const readme = await tools.read({ path: "README.md" }); const files = await tools.glob({ pattern: "*.md" }); console.log("${marker}"); return files.includes("README.md") && readme.includes("demo");`
  const row = (state) => page.getByRole("button", { name: `${state} script details` })
  const calls = page.getByRole("list", { name: "Nested tool calls" }).getByRole("listitem")
  // Simple detail (what an instance with no sessions starts in) folds a
  // turn's work behind one line, where a script counts as "other"; Full
  // shows the row at once.
  const folded = page.getByRole("button", { name: "1 other", exact: true })
  const unfold = async () => {
    await row("Expand").or(folded).first().waitFor()
    if (await folded.isVisible()) await folded.click()
  }
  // The prompt holds the code and the marker too, so each check names the element that shows it.
  const openRowShowsTheRun = async () => {
    await row("Expand").click()
    await expect(page.getByRole("code").filter({ hasText: "tools.glob" })).toBeVisible()
    await expect(calls).toHaveCount(2)
    await expect(calls.nth(0)).toContainText("read")
    await expect(calls.nth(1)).toContainText("glob")
    await expect(page.getByText(`${marker} true`, { exact: true })).toBeVisible()
    await expect(row("Collapse")).toContainText("2 calls")
  }

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("the model calls script and the row takes the script's description", async () => {
    await send(`drive:script ${code}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
    await unfold()
    await expect(row("Expand")).toContainText("Drive script")
  })

  await step("the open row shows the code, the nested calls, the result and the call count", async () => {
    await openRowShowsTheRun()
  })

  await step("the server stored the trace and the model asked for one script call", async () => {
    const lead = await history(sessionId())
    const call = lead.messages.find((m) => m.role === "tool")
    expect(call.name).toBe("script")
    // History leaves a tool's result out; the row loads it when it opens.
    const result = await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)
    expect(result.content).toMatch(/^calls \(2, /)
    expect(result.content).toContain(`output:\n${marker}\ntrue`)
    const asked = modelRequests().filter((r) => r.answer[0] === "script" && r.answer[1].includes(marker))
    expect(asked.map((r) => r.protocol)).toEqual(["chat"])
  })

  await step("the row is the same after a reload", async () => {
    await page.reload({ waitUntil: "load" })
    await unfold()
    await expect(row("Expand")).toContainText("Drive script")
    await openRowShowsTheRun()
  })
}

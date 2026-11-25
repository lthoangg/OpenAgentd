// Background `shell` commands: a server that only runs, a build the session
// waits for and whose result brings the agent back, the line under the
// transcript with its list and Stop, and the end report.
// Feature notes: ../../features/background-commands.md
export default async function backgroundCommands({ page, expect, step, newSessionInDemo, send, run, api, history, sessionId, modelRequests }) {
  const built = `built-${run}`
  const server = { command: "sleep 600", background: true, description: `Dev server ${run}` }
  const build = { command: `sleep 8; echo ${built}; exit 3`, background: true, wait: true, description: `Build ${run}` }
  const waitingLine = page.getByRole("button", { name: /^Waiting for 1 command/ })
  const runningLine = page.getByRole("button", { name: /^1 command running/ })
  const report = page.locator("[data-command-report]")
  // Simple detail (what an instance with no sessions starts in) folds a
  // finished turn's work behind one line: "1 command", or "1 command, 1
  // report" once the agent answered a command's end. Full shows the rows.
  const folds = page.getByRole("button", { name: /^1 command(, 1 report)?$/ })
  const openFolds = async () => {
    for (const fold of await folds.all()) if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click()
  }

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("a server started in the background only runs: the line does not say it waits", async () => {
    await send(`drive:shell ${JSON.stringify(server)}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
    await expect(runningLine).toBeVisible()
    await expect(waitingLine).toHaveCount(0)
  })

  await step("a build the agent waits for shows as waited, and the list has both with Stop", async () => {
    await send(`drive:shell ${JSON.stringify(build)}`)
    await expect(waitingLine).toBeVisible()
    await waitingLine.click()
    const list = page.getByRole("dialog", { name: "Waiting for" })
    await expect(list.getByText(`Build ${run}`)).toBeVisible()
    await expect(list.getByText(`Dev server ${run}`)).toBeVisible()
    await expect(list.getByText(/Command 1 · \d\d:\d\d · keeps running/)).toBeVisible()
    await expect(list.getByRole("button", { name: "Stop command 1" })).toBeVisible()
    await expect(list.getByRole("button", { name: "Stop command 2" })).toBeVisible()
  })

  await step("the build ends and the agent comes back with its exit code and output", async () => {
    await page.keyboard.press("Escape")
    // The stub answers the report by quoting it: the agent read it.
    await expect(page.getByText(/Stub reply \(chat\): \[shell\]:\s*\[Background command 2 failed: exit code 3 after/)).toBeVisible({ timeout: 20_000 })
    // The agent answered the report, so in Simple detail it is work behind that answer.
    await report.or(page.getByRole("button", { name: "1 command, 1 report", exact: true })).first().waitFor()
    await openFolds()
    await expect(report.getByText("exit 3", { exact: true })).toBeVisible()
    await expect(report.getByText(`Build ${run}`)).toBeVisible()
    await expect(report.locator("pre")).toHaveText(built)
    // Only the server is left.
    await expect(runningLine).toBeVisible()
    await expect(waitingLine).toHaveCount(0)
  })

  await step("the server stored the report, and the model was never asked to poll", async () => {
    const lead = await history(sessionId())
    const row = lead.messages.find((m) => m.extra?.command_exit)
    expect(row.extra.from_agent).toBe("shell")
    expect(row.extra.command_exit).toMatchObject({ number: 2, end: "exited", succeeded: false, exit_code: 3, lines: 1 })
    // From the build's prompt on: the call, the answer to its result, the answer to its report.
    const asked = modelRequests().filter((r) => r.stream && JSON.stringify(r.request).includes(built))
    expect(asked.length).toBe(3)
    const waiting = await api("GET", `/agent/sessions/${sessionId()}/waiting`)
    expect(waiting.items.map((i) => [i.kind, i.number, i.waited])).toEqual([["command", 1, false]])
  })

  await step("Stop on the server's row ends it, and the transcript says it was stopped", async () => {
    await runningLine.click()
    await page.getByRole("dialog", { name: "Running commands" }).getByRole("button", { name: "Stop command 1" }).click()
    await expect(runningLine).toHaveCount(0)
    // No turn follows this end, so it shows after the answer in both styles,
    // and the answer stays where it was.
    await expect(report.getByText("stopped", { exact: true })).toBeVisible()
    await expect(page.getByText(/Stub reply \(chat\): \[shell\]:\s*\[Background command 2 failed/)).toBeVisible()
    expect((await api("GET", `/agent/sessions/${sessionId()}/waiting`)).items).toEqual([])
    // Nobody waited for it, so its end started no turn.
    expect((await history(sessionId())).running).toBe(false)
    expect(modelRequests().filter((r) => r.stream && JSON.stringify(r.request).includes(built)).length).toBe(3)
  })

  await step("after a reload both reports are still there", async () => {
    await page.reload({ waitUntil: "load" })
    await expect(report.getByText("stopped", { exact: true })).toBeVisible()
    await openFolds()
    await expect(report).toHaveCount(2)
    await expect(report.getByText("exit 3", { exact: true })).toBeVisible()
    await expect(report.locator("pre").first()).toHaveText(built)
    // Each call's closed row says what it started, without being opened.
    await expect(page.getByText("started · command 1", { exact: true })).toBeVisible()
    await expect(page.getByText("started · command 2", { exact: true })).toBeVisible()
  })
}

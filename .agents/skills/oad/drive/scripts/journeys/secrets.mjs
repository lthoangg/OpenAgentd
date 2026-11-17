// The agent asks for keys on a card, the user pastes one, the agent uses it
// in a command without the value ever reaching the model, and Settings →
// Secrets lists it. Feature notes: ../../features/secrets.md
import { readdirSync, readFileSync } from "node:fs"

/** Every file under `dir`, recursively. */
const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath ?? e.path}/${e.name}`)

export default async function secrets({ page, expect, step, newSessionInDemo, send, run, api, history, sessionId, modelRequests, phone, open, sandbox }) {
  // A name of its own per run: a key saved by an earlier run would need no card.
  const key = `DRIVE_KEY_${run.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  const optional = `${key}_OPT`
  const value = `drive-secret-${run}-value`
  const request = { action: "request", reason: `Run ${run} needs a key to call the demo service.`, keys: [{ name: key }, { name: optional, optional: true }] }
  const field = page.getByLabel(`${key} value`, { exact: true })
  const nowhere = (text) => expect(text.includes(value), "the value reached a place it must never be").toBe(false)
  let shellCallId = ""
  let sid = ""

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("the agent asks for two keys and a card with masked fields opens", async () => {
    await send(`drive:secret ${JSON.stringify(request)}`)
    await expect(page.getByText("Needs you · secrets").first()).toBeVisible()
    await expect(page.getByText(request.reason, { exact: true })).toBeVisible()
    await expect(field).toHaveAttribute("type", "password")
    await expect(page.getByLabel(`${optional} value`, { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  })

  await step("paste one key, leave the optional one, and save", async () => {
    await field.fill(value)
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
    // A finished turn folds its work at phone width (Simple detail); a user opens it to read the answer.
    const folded = page.getByRole("button", { name: "1 question", exact: true })
    if (await folded.isVisible()) await folded.click()
    await expect(page.getByText(`Provided: ${key}`)).toBeVisible()
    await expect(page.getByText(`Skipped: ${optional}`)).toBeVisible()
  })

  await step("the store holds the key for demo, and the model got names only", async () => {
    const listed = await api("GET", "/secrets")
    const row = listed.secrets.find((s) => s.name === key)
    expect(row.projects.map((p) => p.name)).toEqual(["demo"])
    nowhere(JSON.stringify(listed))
    const lead = await history(sessionId())
    const call = lead.messages.find((m) => m.role === "tool" && m.name === "secret")
    const result = await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)
    expect(result.content).toContain(`The user provided ${key}.`)
    nowhere(JSON.stringify(modelRequests()))
  })

  await step("the agent runs a command with the key and reads it masked", async () => {
    await send(`drive:shell ${JSON.stringify({ command: `echo got=$${key}; printf %s "$${key}" | wc -c`, secrets: [key] })}`)
    await expect(page.getByText("Stub (chat): the tool finished.").nth(1)).toBeVisible()
    const lead = await history(sessionId())
    const call = lead.messages.filter((m) => m.role === "tool" && m.name === "shell").at(-1)
    shellCallId = call.tool_call_id
    sid = sessionId()
    const result = await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)
    expect(result.content).toContain(`got=[secret ${key}]`)
    expect(result.content).toContain(String(value.length))
    nowhere(JSON.stringify(modelRequests()))
    nowhere(JSON.stringify(lead))
  })

  await step("Settings → Secrets lists the key for demo", async () => {
    // A phone's session view has no Settings button; the home screen does.
    if (phone) await open("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings" })
    if (phone) await dialog.getByRole("button", { name: "Secrets", exact: true }).click()
    else await dialog.getByRole("button", { name: "Secrets", exact: true }).first().click()
    await expect(dialog.getByRole("heading", { name: "Secrets", level: 1 })).toBeVisible()
    await expect(dialog.getByText(key, { exact: true })).toBeVisible()
    nowhere(await dialog.innerText())
  })

  await step("no file the server wrote holds the value but credentials.yaml", async () => {
    // The span of the very call that used the key must be on disk, so the scan covers its telemetry.
    const spans = () => filesUnder(`${sandbox}/state/otel/spans`).map((f) => readFileSync(f, "utf8")).join("\n")
    await expect.poll(() => spans().includes(shellCallId), { timeout: 15_000 }).toBe(true)
    const credentials = `${sandbox}/config/credentials.yaml`
    expect(readFileSync(credentials, "utf8").includes(value), "the scan finds the value where it is kept").toBe(true)
    const holders = filesUnder(sandbox).filter((f) => f !== credentials && readFileSync(f).includes(value))
    expect(holders, "OTEL spans, the database and its WAL, logs, home and workspace hold no value").toEqual([])
    // The transcript a user copies or exports is the session's history.
    nowhere(JSON.stringify(await history(sid)))
  })
}

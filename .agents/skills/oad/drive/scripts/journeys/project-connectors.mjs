// A connector the project ships in .agents/mcp.json: the "+" menu lists it
// needing approval, Allow starts it, the agent uses it in the session, a
// changed entry asks again, Settings lists it, and deleting the file stops it.
// Feature notes: ../../features/project-connectors.md
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"

const ECHO_SERVER = `import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "echo", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo text back", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"].get("x", "")}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
`

export default async function projectConnectors({ page, expect, step, phone, api, demo, newSessionInDemo, send, run, history, sessionId }) {
  const name = `echo-${run}`
  const python = execFileSync("/usr/bin/env", ["which", "python3"]).toString().trim()
  // The server program lives outside the repository; only the entry is the project's.
  const script = `${demo}/../echo-mcp-${run}.py`
  writeFileSync(script, ECHO_SERVER)
  const file = `${demo}/.agents/mcp.json`
  const writeEntry = (args) => {
    mkdirSync(`${demo}/.agents`, { recursive: true })
    writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command: python, args } } }))
  }
  // The app names a workspace by its real path (/tmp is /private/tmp on macOS).
  const workspace = realpathSync(demo)
  const listed = async () => (await api("GET", `/mcp/servers?workspace=${encodeURIComponent(workspace)}`)).servers.find((s) => s.project?.name === name)

  const connectors = page.getByRole("region", { name: "Connectors" })
  const row = () => connectors.getByRole("listitem", { name })
  const openPlusConnectors = async () => {
    await page.getByRole("button", { name: "Add to message" }).click()
    // The phone sheet keeps connectors on a page of their own; a connector
    // waiting on the user opens the sheet right at that page.
    const page2 = page.getByRole("button", { name: "Connectors" })
    if (phone && !(await connectors.isVisible())) await page2.click()
    await expect(connectors).toBeVisible()
  }

  await step("the + menu lists the project's connector, waiting for approval", async () => {
    writeEntry([script])
    await newSessionInDemo()
    await openPlusConnectors()
    await expect(row().getByText("from this project")).toBeVisible()
    await expect(row().getByText("Needs approval")).toBeVisible()
    await expect(row().getByRole("button", { name: "Allow" })).toBeVisible()
    expect((await listed()).state).toBe("needs_approval")
  })

  await step("Allow starts it", async () => {
    await row().getByRole("button", { name: "Allow" }).click()
    await expect(row().getByText("Ready · 1 tool")).toBeVisible({ timeout: 30_000 })
    await expect(row().getByRole("button", { name: "Revoke" })).toBeVisible()
    expect((await listed()).state).toBe("ready")
    await page.keyboard.press("Escape")
  })

  await step("the agent uses it by its name in this session", async () => {
    const code = `return await tools.mcp({ action: "call", server: "${name}", tool: "echo", arguments: { x: "hi-${run}" } })`
    await send(`drive:script ${code}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible({ timeout: 30_000 })
    const lead = await history(sessionId())
    const call = lead.messages.filter((m) => m.role === "tool").at(-1)
    const result = await api("GET", `/agent/${sessionId()}/tool-results/${call.tool_call_id}`)
    expect(result.content).toContain(`got hi-${run}`)
  })

  await step("a changed entry asks for approval again", async () => {
    writeEntry([script, "--changed"])
    await openPlusConnectors()
    await expect(row().getByText("Needs approval")).toBeVisible({ timeout: 15_000 })
    await expect(row().getByRole("button", { name: "Allow" })).toBeVisible()
    expect((await listed()).state).toBe("needs_approval")
    await page.keyboard.press("Escape")
  })

  await step("Settings → Connectors lists it from this project", async () => {
    // A phone keeps Settings in the Sessions toolbar.
    if (phone) await page.getByRole("button", { name: "Back to Sessions" }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await dialog.getByRole("button", { name: /^Connectors\b/ }).click()
    await expect(dialog.getByRole("heading", { name: "Your connectors" })).toBeVisible({ timeout: 15_000 })
    const entry = dialog.getByText(name, { exact: true })
    await entry.scrollIntoViewIfNeeded()
    await expect(entry).toBeVisible()
    await expect(dialog.getByText("from this project", { exact: true })).toBeVisible()
  })

  await step("deleting the file stops it", async () => {
    rmSync(file)
    await expect.poll(async () => (await listed()) ?? null, { timeout: 15_000 }).toBeNull()
    rmSync(script)
  })
}

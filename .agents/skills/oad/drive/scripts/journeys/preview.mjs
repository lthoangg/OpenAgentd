// The agent keeps using a preview page after the user closed the Browser tab
// and moved to another session: the page stays loaded out of sight.
// Feature notes: ../../features/preview.md
import { writeFileSync } from "node:fs"

export default async function preview({ page, expect, step, newSessionInDemo, send, run, api, history, sessionId, demo, phone }) {
  const file = `preview-${run}.html`
  writeFileSync(`${demo}/${file}`, `<!doctype html><html><body><button onclick="this.textContent='Clicked ${run}'">Ping ${run}</button></body></html>\n`)
  const frame = page.frameLocator(`iframe[title="Browser page of ${file}"]`)
  let first

  await step("start a new session in demo", async () => {
    await newSessionInDemo()
  })

  await step("the agent opens a page and the Browser tab shows it", async () => {
    await send(`drive:browser {"action": "open", "path": "${file}"}`)
    await expect(page.getByText("Stub (chat): the tool finished.")).toBeVisible()
    first = sessionId()
    if (phone) return // a phone opens it only from the tool row (see the feature's Gotchas)
    await expect(frame.getByRole("button", { name: `Ping ${run}` })).toBeVisible()
  })

  if (!phone) {
    await step("the user closes the Browser tab", async () => {
      await page.getByRole("button", { name: `Close Browser ${file}` }).click()
      await expect(page.locator(`iframe[title="Browser page of ${file}"]`)).toHaveCount(0)
    })
  }

  await step("the user starts another session and the app reloads on it", async () => {
    if (phone) await newSessionInDemo()
    else await page.getByRole("button", { name: "New session", exact: true }).click()
    await send(`hello ${run}`)
    await expect(page.getByText(`Stub reply (chat): hello ${run}`)).toBeVisible()
    expect(sessionId() ?? first).not.toBe(first)
    // A reload forgets everything this window saw the agent open.
    await page.reload({ waitUntil: "load" })
    await expect(page.getByText(`Stub reply (chat): hello ${run}`)).toBeVisible()
  })

  await step("the first session's agent, not on screen, clicks the page and reads it", async () => {
    // The agent runs in the background here: the user is on the other session.
    const form = new FormData()
    form.set("session_id", first)
    form.set("message", `drive:script await tools.browser({ action: "click", selector: "button" }); return await tools.browser({ action: "snapshot" });`)
    form.set("interaction_mode", "code")
    form.set("workspace", demo)
    await api("POST", "/agent/chat", form)
    let lead
    for (let i = 0; i < 150; i++) {
      lead = await history(first)
      if (!lead.running && lead.messages.some((m) => m.role === "tool" && m.name === "script")) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const call = lead.messages.filter((m) => m.role === "tool" && m.name === "script").pop()
    const result = await api("GET", `/agent/${first}/tool-results/${call.tool_call_id}`)
    if (phone) {
      // No window keeps a page loaded on a phone: the agent is told why, not to open it again.
      expect(result.content).toContain("did not connect")
      expect(result.content).not.toContain("action 'open' again to load it")
    } else {
      expect(result.content).toContain(`Clicked ${run}`)
      // The page was used out of sight: no Browser tab came back.
      await expect(page.locator(`iframe[title="Browser page of ${file}"]`)).toHaveCount(0)
    }
  })

  await step("the server lists the page as the agent's", async () => {
    const { previews } = await api("GET", "/preview")
    expect(previews.some((p) => p.agent_page?.path === file)).toBe(true)
  })
}

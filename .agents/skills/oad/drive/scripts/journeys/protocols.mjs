// One turn with text and one with a tool call over each of the two other
// wire protocols: Anthropic Messages and OpenAI Responses. (The message and
// review journeys cover OpenAI Chat Completions.)
// Feature notes: ../../features/protocols.md
import { readFileSync } from "node:fs"

export default async function protocols({ page, expect, step, newSessionInDemo, send, seedSession, open, run, demo, modelRequests }) {
  await step("pick the Anthropic model in the picker", async () => {
    await newSessionInDemo()
    await page.getByRole("button", { name: /^Model .*Change/ }).click()
    const picker = page.getByRole("dialog", { name: "Model and thinking" })
    await picker.getByRole("option", { name: "stub", exact: true }).click() // the Anthropic one; Ollama's reads "stub default"
    // On a phone the picker is a sheet that stays open after a choice.
    if (await picker.isVisible()) await page.keyboard.press("Escape")
    await expect(picker).toBeHidden()
    await expect(page.getByRole("button", { name: /^Model anthropic:stub\. Change/ })).toBeVisible()
  })

  await step("text over Messages", async () => {
    await send(`Over messages at ${run}`)
    await expect(page.getByText(`Stub reply (messages): Over messages at ${run}`)).toBeVisible()
  })

  await step("a tool call over Messages", async () => {
    await send(`drive:shell echo messages-${run} > proto-messages-${run}.txt`)
    await expect(page.getByText("Stub (messages): the tool finished.")).toBeVisible()
    expect(readFileSync(`${demo}/proto-messages-${run}.txt`, "utf8").trim()).toBe(`messages-${run}`)
  })

  // The picker offers no thinking level for the stub model, and a thinking
  // level is what selects the Responses API, so the first turn is seeded.
  let seeded
  await step("continue a session that uses Responses", async () => {
    seeded = await seedSession(`Seed responses at ${run}`, { model: "ollama:stub", thinking_level: "medium" })
    await open(`/${seeded}`)
    await expect(page.getByText(`Stub reply (responses): Seed responses at ${run}`)).toBeVisible()
  })

  await step("text and a tool call over Responses", async () => {
    await send(`drive:shell echo responses-${run} > proto-responses-${run}.txt`)
    await expect(page.getByText("Stub (responses): the tool finished.")).toBeVisible()
    expect(readFileSync(`${demo}/proto-responses-${run}.txt`, "utf8").trim()).toBe(`responses-${run}`)
  })

  await step("the model log shows both protocols carried tool calls", async () => {
    const calls = modelRequests().filter((r) => r.answer[0] === "shell" && r.answer[1].includes(`-${run} > proto-`))
    expect(calls.map((r) => r.protocol).sort()).toEqual(["messages", "responses"])
  })
}

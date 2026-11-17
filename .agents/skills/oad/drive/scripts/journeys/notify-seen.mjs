// A session on screen is reported seen to its server, so its notification
// does not also ring the account's phone a minute later.
// Feature notes: ../../features/notify-seen.md
import { readFileSync } from "node:fs"

const LOG = `${process.env.DRIVE_DIR}/state/logs/app/app.log`

/** How many times the server heard `session_seen` for `id`. */
function seenReports(id) {
  let text = ""
  try {
    text = readFileSync(LOG, "utf8")
  } catch {
    return 0
  }
  return text.split("\n").filter((line) => line.includes(`session_seen session_id=${id}`)).length
}

export default async function notifySeen({ page, expect, step, newSessionInDemo, send, run, sessionId }) {
  const text = `Watch this finish ${run}`
  let opened = 0

  await step("start a session and send a message", async () => {
    await newSessionInDemo()
    await send(text)
    await expect(page.getByRole("main").getByText(text, { exact: true })).toBeVisible()
  })

  await step("opening the session reported it seen", async () => {
    await expect.poll(() => seenReports(sessionId()), { timeout: 10_000 }).toBeGreaterThan(0)
    opened = seenReports(sessionId())
  })

  await step("the turn ends while the session is on screen", async () => {
    await expect(page.getByText(`Stub reply (chat): ${text}`)).toBeVisible()
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible()
  })

  await step("its notification was reported seen too, inside the 10 s gap", async () => {
    await expect.poll(() => seenReports(sessionId()), { timeout: 10_000 }).toBeGreaterThan(opened)
  })
}

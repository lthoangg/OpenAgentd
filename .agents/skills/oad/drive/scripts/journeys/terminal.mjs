// Run a command in the terminal of a session's workspace; on a phone, drive
// the key bar and the touch gestures.
// Feature notes: ../../features/terminal.md
import { existsSync } from "node:fs"

export default async function terminal({ page, expect, step, seedSession, open, openInReviewPanel, run, demo, phone, hold }) {
  const id = await seedSession(`Terminal session ${run}`)
  const marker = `terminal-${run}-${Date.now()}.txt`

  let panel
  await step("open the terminal", async () => {
    await open(`/${id}`)
    panel = await openInReviewPanel("Terminal", (p) => p.getByRole("textbox", { name: "Terminal input" }))
    await expect(panel.locator(".xterm-rows")).toBeVisible()
  })

  await step("a command prints its result", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    // The workspace's shell outlives a run: start from an empty prompt line
    // even if an earlier, failed run left text on it (Ctrl+U clears it).
    await page.keyboard.press("Control+u")
    // The shell computes 42, so the echoed command line alone cannot pass.
    await page.keyboard.type(`echo drive-$((40+2)) && touch ${marker}`)
    await page.keyboard.press("Enter")
    await expect(panel.locator(".xterm-rows")).toContainText("drive-42")
  })

  await step("it ran in the session's workspace", async () => {
    await expect.poll(() => existsSync(`${demo}/${marker}`)).toBe(true)
  })

  if (!phone) return

  const rows = panel.locator(".xterm-rows")
  const keys = panel.getByRole("toolbar", { name: "Terminal keys" })
  const size = page.viewportSize()
  const rowsText = () => rows.innerText()
  const count = async (text) => (await rowsText()).split(text).length - 1
  // Fingers on the terminal, through the browser's touch input: each frame is
  // the touch points at that moment (none: lifted), then a pause in ms.
  const box = async () => (await panel.locator(".xterm-screen").boundingBox())
  async function fingers(frames) {
    const cdp = await page.context().newCDPSession(page)
    let down = false
    for (const [points, wait = 0] of frames) {
      const type = points.length === 0 ? "touchEnd" : down ? "touchMove" : "touchStart"
      await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) })
      down = points.length > 0
      if (wait) await page.waitForTimeout(wait)
    }
    await cdp.detach()
  }

  await step("keyboard down: the keys that answer a prompt", async () => {
    await expect(keys.getByRole("button", { name: "Enter" })).toBeVisible()
    await expect(keys.getByRole("button", { name: "Show keyboard" })).toBeVisible()
    await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toHaveCount(0)
  })

  await step("↑ then Enter from the bar runs the last command again", async () => {
    const before = await count("drive-42")
    await keys.getByRole("button", { name: "Arrow up" }).click()
    await keys.getByRole("button", { name: "Enter" }).click()
    await expect.poll(() => count("drive-42")).toBeGreaterThan(before)
  })

  await step("a double tap sends Tab, which completes a file name", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    await page.keyboard.type("cat READ")
    const b = await box()
    const at = [b.x + b.width / 2, b.y + b.height / 2]
    await fingers([[[at]], [[], 80], [[at]], [[]]])
    await expect(rows).toContainText("cat README.md")
    await keys.getByRole("button", { name: "Send Ctrl+C (interrupt)" }).click()
  })

  await step("hold, then drag up: the arrow key brings back the last command", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    await page.keyboard.type(`echo hold-${run}`)
    await page.keyboard.press("Enter")
    await expect(rows).toContainText(`hold-${run}\n`)
    const b = await box()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    // A short drag, lifted before the slowest repeat (300 ms): one arrow up.
    await fingers([[[[x, y]], 700], [[[x, y - 20]], 150], [[]]])
    // The line after the last prompt (wrapped over several rows).
    await expect.poll(async () => (await rowsText()).split("% ").at(-1).replace(/\n/g, "")).toContain(`echo hold-${run}`)
    // The hold's release opened no menu.
    await expect(page.getByRole("dialog", { name: "Terminal" })).toHaveCount(0)
    await keys.getByRole("button", { name: "Send Ctrl+C (interrupt)" }).click()
  })

  await step("a drag down scrolls back through the output", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    await page.keyboard.type("seq 1 300")
    await page.keyboard.press("Enter")
    await expect(rows).toContainText("299")
    const b = await box()
    const x = b.x + b.width / 2
    const frames = [[[[x, b.y + 60]], 16]]
    for (let dy = 20; dy <= 400; dy += 20) frames.push([[[x, b.y + 60 + dy]], 16])
    frames.push([[]])
    await fingers(frames)
    await expect(rows).not.toContainText("299")
  })

  await step("a pinch makes the text bigger, and More resets it", async () => {
    const fontSize = () => rows.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    const before = await fontSize()
    const b = await box()
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const frames = []
    for (let r = 40; r <= 80; r += 5) frames.push([[[cx - r, cy], [cx + r, cy]], 16])
    frames.push([[]])
    await fingers(frames)
    await expect.poll(fontSize).toBeGreaterThan(before)
    await keys.getByRole("button", { name: "More keys" }).click()
    await page.getByRole("button", { name: "Reset" }).click()
    await expect.poll(fontSize).toBe(before)
    await expect(page.getByRole("dialog", { name: "More keys" })).toHaveCount(0)
  })

  await step("a long press opens the terminal menu: four rows", async () => {
    await hold(panel.locator(".xterm-screen"))
    const menu = page.getByRole("dialog", { name: "Terminal" })
    await expect(menu.getByRole("button")).toHaveText(["Select Text", "Paste", "Find", "Clear"])
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  })

  await step("keyboard up: the typing keys, in one row", async () => {
    await panel.getByRole("textbox", { name: "Terminal input" }).focus()
    // The soft keyboard takes the bottom of the screen: the visible viewport shrinks.
    await page.setViewportSize({ width: size.width, height: size.height - 300 })
    await expect(keys.getByRole("button", { name: "Ctrl", exact: true })).toBeVisible()
    await expect(keys.getByRole("button", { name: "Arrow right" })).toBeVisible()
    await expect(keys.getByRole("button", { name: "More keys" })).toBeVisible()
    const scrolls = await keys.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(scrolls).toBe(false)
  })

  await step("keyboard down again: the reading keys come back", async () => {
    await page.setViewportSize(size)
    await expect(keys.getByRole("button", { name: "Enter" })).toBeVisible()
  })
}

// What a screen says when something fails or is still loading, and the
// shared confirm and action sheet (DESIGN.md → Rulebook 7, and DESIGN.md → Rulebook 10): a folder
// list that failed, a workspace whose sessions could not be read, the
// TypeScript tools line, a title loading in Usage and in a Read row, deleting a workspace
// group, the QR scanner's focus, and ✎'s sheet on a phone.
// Feature notes: ../../features/ui-states.md
export default async function uiStates({ page, expect, step, open, phone, run, demo, seedSession, newSessionInDemo, hold }) {
  /** Sessions on a phone, which reopens the last session at `/`. */
  const home = async () => {
    await open("/")
    if (!phone) return
    const back = page.getByRole("button", { name: "Back to Sessions" })
    const sessions = page.getByRole("heading", { name: "Sessions", level: 1 })
    await back.or(sessions).first().waitFor()
    if (await back.isVisible()) await back.click()
  }
  /** Wait for the page's finite animations (a toast or a sheet coming in), so the photo shows it settled. A cancelled one counts as done. */
  const settled = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {}))))
  const down = (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The server is busy." }) })

  await step("a folder list that fails to load says so, with Retry", async () => {
    // The picker needs a folder to start in: open demo first.
    await newSessionInDemo()
    await page.route("**/agent/workspace/tree", down)
    // A reload of the draft, as after the app was away: nothing cached to fall back on.
    await page.reload({ waitUntil: "load" })
    // A phone reopens on Sessions, whose list is where its folders are; a
    // desktop stays on the draft, whose folder chip has the picker.
    const where = phone ? page.getByRole("complementary").first() : page.getByRole("main")
    const says = phone ? "Couldn't load workspaces." : "Couldn't load folders."
    // The app retries a failed read a few times (about 7 s) before it says so.
    await expect(where.getByText(says)).toBeVisible({ timeout: 20_000 })
    await expect(where.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  })

  await step("Retry loads them", async () => {
    await page.unroute("**/agent/workspace/tree")
    const where = phone ? page.getByRole("complementary").first() : page.getByRole("main")
    await where.getByRole("button", { name: "Retry", exact: true }).click()
    await expect(page.getByText(/Couldn't load (folders|workspaces)\./)).toHaveCount(0)
  })

  await step("a workspace whose sessions cannot be read says so, not a blank draft", async () => {
    await page.route(/\/agent\/sessions\?/, down)
    await open("/")
    const list = page.getByRole("complementary").first()
    await list.getByRole("button", { name: "Open workspace demo", exact: true }).click()
    const toast = page.getByText("Couldn't open the last session")
    await expect(toast).toBeInViewport({ timeout: 20_000 })
    await settled()
    await page.unroute(/\/agent\/sessions\?/)
  })

  await step("a folder missing TypeScript tools gets one status line, not a dialog", async () => {
    // The server says so on the app's event feed when an edit needs the
    // tools; this one is answered with that event, then left to the server.
    let served = false
    await page.route("**/events/stream*", async (route) => {
      if (served) return route.continue()
      served = true
      const data = JSON.stringify({ component: "typescript", workspace: demo, downloads_enabled: true, language_server_version: "4.3.3", typescript_version: "5.8.2" })
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: `event: lsp_install_required\ndata: ${data}\n\n` })
    })
    await home()
    const line = page.getByRole("status", { name: "Install TypeScript language tools" })
    await expect(line).toBeVisible()
    await expect(line.getByText("Install TypeScript tools for demo?")).toBeVisible()
    await expect(line.getByRole("button", { name: "Install", exact: true })).toBeVisible()
    await expect(page.getByRole("dialog", { name: /TypeScript/ })).toHaveCount(0)
    await page.unroute("**/events/stream*")
    await settled()
  })

  await step("Later closes it", async () => {
    await page.getByRole("status", { name: "Install TypeScript language tools" }).getByRole("button", { name: "Later", exact: true }).click()
    await expect(page.getByRole("status", { name: "Install TypeScript language tools" })).toHaveCount(0)
  })

  await step("a session's title loading in Usage shows a skeleton, not a word", async () => {
    const id = await seedSession(`Usage of ${run}`)
    // Hold the summary that names the session, so the loading state stays long enough to see.
    await page.route("**/observability/summary*", async (route) => {
      await new Promise((r) => setTimeout(r, 6000))
      await route.continue().catch(() => {})
    })
    await open(`/telemetry?session=${id}`)
    // A phone folds the filters, the session's among them, under one button.
    if (phone) await page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: /^Filters/ }).click()
    await expect(page.getByRole("status", { name: "Loading the session's title" })).toBeVisible()
    await expect(page.getByText("Loading…")).toHaveCount(0)
  })

  await step("then the session's name", async () => {
    await expect(page.getByRole("status", { name: "Loading the session's title" })).toHaveCount(0, { timeout: 10_000 })
    await page.unroute("**/observability/summary*")
  })

  await step("closed, Usage stays closed when the app opens again", async () => {
    // Escape closes what is on top: on a phone the Filters sheet, then Done closes Usage.
    await page.keyboard.press("Escape")
    if (phone) await page.getByRole("dialog", { name: "Usage" }).getByRole("button", { name: "Done", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Usage" })).toHaveCount(0)
    await home()
    // The link that opened it is not saved as the place to come back to.
    const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("oa-last-route")).map((k) => localStorage.getItem(k)))
    expect(saved.some((route) => route?.startsWith("/telemetry"))).toBe(false)
    await expect(page.getByRole("dialog", { name: "Usage" })).toHaveCount(0)
  })

  await step("a Read row's line count loading shows a skeleton, not a word", async () => {
    const id = await seedSession(`Read for ${run}\ndrive:read {"path": "README.md"}`)
    // Hold the result the row fetches once opened, so the loading state stays to be seen.
    await page.route("**/tool-results/**", async (route) => {
      await new Promise((r) => setTimeout(r, 6000))
      await route.continue().catch(() => {})
    })
    await open(`/${id}`)
    // The turn's tool calls may be folded into one line, "1 read", first.
    const folded = page.getByRole("button", { name: "1 read", exact: true })
    const row = page.getByRole("button", { name: "Expand read details", exact: true })
    await folded.or(row).first().waitFor()
    if (await folded.isVisible()) await folded.click()
    await row.click()
    await expect(page.getByRole("status", { name: "Loading lines" })).toBeVisible()
    await expect(page.getByText("Loading…")).toHaveCount(0)
  })

  await step("then the lines it read", async () => {
    // A whole-file read has no range to count, so the lines themselves show.
    await expect(page.getByText("A repository the drive journeys change.")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("status", { name: "Loading lines" })).toHaveCount(0)
    await page.unroute("**/tool-results/**")
  })

  const group = `Group ${run}`
  await step("deleting a workspace group asks first, with Cancel", async () => {
    await home()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await dialog.getByRole("button", { name: "Workspaces", exact: true }).click()
    await dialog.getByRole("button", { name: "New group" }).click()
    await dialog.getByRole("textbox", { name: "Group name" }).fill(group)
    await dialog.getByRole("button", { name: "Create group" }).click()
    await dialog.getByRole("button", { name: `Delete group ${group}` }).click()
    const confirm = page.getByRole("alertdialog", { name: `Delete ${group}?` }).or(page.getByRole("dialog", { name: `Delete ${group}?` }))
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
    await expect(confirm.getByRole("button", { name: "Delete group", exact: true })).toBeVisible()
  })

  await step("Cancel keeps the group", async () => {
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Settings" }).getByText(group, { exact: true })).toBeVisible()
  })

  // The scanner needs the phone's camera, which a browser does not have:
  // the journey mounts the app's own viewfinder (QrScanOverlay, served by
  // the dev server with the app's React) beside an opener, in place of the
  // camera call, and checks it the way a keyboard user meets it.
  await step("the QR scanner takes focus on Cancel", async () => {
    await home()
    await page.evaluate(async () => {
      const source = await (await fetch("/src/components/phone/QrScanOverlay.tsx")).text()
      const reactUrl = source.match(/"(\/node_modules\/\.vite\/deps\/react\.js\?v=[^"]+)"/)[1]
      const version = reactUrl.split("?v=")[1]
      const reactModule = await import(reactUrl)
      const React = reactModule.default ?? reactModule
      const client = await import(`/node_modules/.vite/deps/react-dom_client.js?v=${version}`)
      const createRoot = client.createRoot ?? client.default.createRoot
      const { QrScanOverlay } = await import("/src/components/phone/QrScanOverlay.tsx")
      const h = React.createElement
      function Harness() {
        const [open, setOpen] = React.useState(false)
        return h("div", { style: { position: "fixed", left: 16, bottom: 96, zIndex: 70 } },
          h("button", { type: "button", onClick: () => setOpen(true) }, "Open the scanner"),
          open && h(QrScanOverlay, { onCancel: () => setOpen(false) }))
      }
      const host = document.createElement("div")
      document.body.append(host)
      createRoot(host).render(h(Harness))
    })
    await page.getByRole("button", { name: "Open the scanner" }).click()
    const scanner = page.getByRole("dialog", { name: "Scan QR code" })
    await expect(scanner).toBeVisible()
    await expect(scanner.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
    await settled()
  })

  await step("Escape cancels it and focus goes back to the opener", async () => {
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Scan QR code" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open the scanner" })).toBeFocused()
  })

  if (phone) {
    await step("holding ✎ opens a sheet of folders with a Cancel row", async () => {
      await home()
      await hold(page.getByRole("button", { name: "New session", exact: true }))
      const sheet = page.getByRole("dialog", { name: "New session in…" })
      await expect(sheet.getByRole("button", { name: /demo/ }).first()).toBeVisible()
      await expect(sheet.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 })
      await settled()
      // The release's click must not have closed it.
      await expect(sheet).toBeVisible()
    })

    await step("Cancel closes it", async () => {
      await page.getByRole("dialog", { name: "New session in…" }).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "New session in…" })).toHaveCount(0)
    })
  }
}

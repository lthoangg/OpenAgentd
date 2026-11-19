// Drive the instance `drive.sh up` started, the way a user does, at a phone
// width and a desktop width. Run it through `drive.sh run [journey…]`.
//
// A journey is a file in journeys/ that exports `default async (ctx) => {}`.
// It calls `ctx.step(name, fn)` for each user action: the step acts, waits
// for the state a user would see, and the page is then photographed. When a
// step fails, the page's accessibility outline is saved beside the
// screenshot, so the failure can be read without opening an image.
//
// Results land in $OUT_DIR: <journey>-<width>-<n>-<step>.png, report.json and
// model-requests.jsonl (what the app sent to the model). Exit code 1 when any
// journey fails.
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"

const ROOT = process.env.ROOT
const DRIVE_DIR = process.env.DRIVE_DIR
const WEB_URL = process.env.WEB_URL
const API = process.env.API
const OUT_DIR = process.env.OUT_DIR
const HERE = new URL(".", import.meta.url).pathname

// Playwright is installed once, for the README screenshots.
const { chromium, expect } = createRequire(`${ROOT}/scripts/readme-shots/`)("playwright/test")

const WIDTHS = {
  phone: { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1440, height: 900 } },
}

/** Call the drive instance's own API: for preconditions and cross-checks only. */
async function api(method, path, body) {
  const init = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) Object.assign(init, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const res = await fetch(`${API}${path}`, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

/** The lead agent's messages of a session, oldest first. */
async function history(sessionId) {
  return (await api("GET", `/agent/${sessionId}/history`)).lead
}

/** Precondition: a finished session in the demo repository. Returns its id. */
async function seedSession(message, fields = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries({ workspace: `${DRIVE_DIR}/code/demo`, message, interaction_mode: "code", ...fields })) form.set(k, v)
  const { session_id: id } = await api("POST", "/agent/chat", form)
  for (let i = 0; i < 150; i++) {
    if (!(await history(id)).running) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`session ${id} was still running after 30 s`)
}

async function runJourney(browser, name, run, width, report) {
  const context = await browser.newContext({ ...WIDTHS[width], reducedMotion: "reduce", deviceScaleFactor: 1 })
  // Headless screenshots miss xterm's WebGL canvas; without WebGL it uses the DOM renderer.
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return type === "webgl2" || type === "webgl" ? null : getContext.call(this, type, ...rest)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  const entry = { journey: name, width, ok: true, steps: [], pageErrors }
  report.push(entry)
  let n = 0
  const ctx = {
    page,
    expect,
    width,
    phone: width === "phone",
    /** Unique per journey run: put it in prompts and file names so an earlier run's leftovers cannot pass a check. */
    run: `${width}-${Date.now().toString(36)}`,
    api,
    history,
    seedSession,
    demo: `${DRIVE_DIR}/code/demo`,
    /** The server's sandbox: its config, data, state (OTEL spans) and log, for side-effect checks. */
    sandbox: DRIVE_DIR,
    open: async (path = "/") => {
      await page.goto(WEB_URL + path, { waitUntil: "load" })
    },
    /**
     * Start a new session in the demo repository, opening the folder through
     * the Open workspace dialog the first time and from the folder list after.
     */
    async newSessionInDemo() {
      await ctx.open("/")
      if (ctx.phone) await page.getByRole("button", { name: "New session", exact: true }).click()
      await page.getByRole("button", { name: /^Folder: .*Change folder$/ }).click()
      await page.getByRole("listbox", { name: "Folders" }).waitFor()
      const known = page.getByRole("option", { name: "demo", exact: true })
      if (await known.count()) {
        await known.click()
      } else {
        await page.getByRole("option", { name: "Open workspace…" }).click()
        const dialog = page.getByRole("dialog", { name: "Open workspace" })
        await dialog.getByRole("button", { name: "..", exact: true }).click() // out of the sandbox home
        await dialog.getByRole("button", { name: "code", exact: true }).click()
        await dialog.getByRole("button", { name: "demo", exact: true }).click()
        await expect(dialog.getByText(/\/code\/demo$/)).toBeVisible()
        await dialog.getByRole("button", { name: "Open this folder" }).click()
        await page.getByRole("dialog", { name: "Let agents work in demo?" }).getByRole("button", { name: "Allow and open" }).click()
      }
      await expect(page.getByRole("button", { name: /^Folder: demo\. Change folder$/ })).toBeVisible()
      await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible()
    },
    /** Type a message in the composer and send it. */
    async send(text) {
      await page.getByRole("textbox", { name: "Message input" }).fill(text)
      await page.getByRole("button", { name: "Send message" }).click()
    },
    /**
     * Open the Review panel and the tool named `tool` in it ("Git" or
     * "Terminal"). The panel is in one of three states: the tool is already
     * showing, the launcher lists it, or another tool is open and the
     * "Open in Review panel" menu lists it. `ready` picks the element that
     * proves the tool is showing.
     */
    async openInReviewPanel(tool, ready) {
      const panel = page.getByRole("complementary", { name: "Review panel" })
      if (!(await panel.isVisible())) await page.getByRole("button", { name: "Review panel", exact: true }).click()
      const named = new RegExp(`^${tool}( \\(| \\d|$)`)
      const launcher = panel.getByRole("button", { name: named })
      const settled = await ready(panel).or(launcher).first().waitFor({ timeout: 1500 }).then(() => true, () => false)
      if (await ready(panel).isVisible()) return panel
      if (settled) {
        await launcher.first().click()
      } else {
        await panel.getByRole("button", { name: "Open in Review panel", exact: true }).click()
        // A menu on desktop, a sheet of buttons on a phone.
        const menu = page.getByRole("menu", { name: "Open in Review panel" }).getByRole("menuitem", { name: named })
        const sheet = page.getByRole("dialog", { name: "Open in Review panel" }).getByRole("button", { name: named })
        await menu.or(sheet).first().click()
      }
      await ready(panel).waitFor()
      return panel
    },
    /** What the app has sent to the model so far: [{ protocol, stream, answer, request }]. */
    modelRequests: () =>
      readFileSync(`${DRIVE_DIR}/model.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    /** The stub's OpenAI-compatible base URL, for a provider a journey points at it. */
    modelUrl: process.env.MODEL_URL,
    /** The session the page shows, read from its address. */
    sessionId: () => new URL(page.url()).pathname.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0],
    /** Press and hold with a finger (phone only): what opens a row's action sheet. */
    hold: async (locator, ms = 700) => {
      const box = await locator.boundingBox()
      if (!box) throw new Error("nothing to hold: the element is not on screen")
      const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
      await page.waitForTimeout(ms)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await cdp.detach()
    },
    async step(stepName, fn) {
      n += 1
      const base = `${name}-${width}-${n}-${stepName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
      const record = { step: stepName, ok: true, screenshot: `${base}.png` }
      entry.steps.push(record)
      try {
        await fn()
        await page.screenshot({ path: `${OUT_DIR}/${base}.png` })
      } catch (error) {
        record.ok = false
        record.error = String(error).split("\n").slice(0, 8).join("\n")
        await page.screenshot({ path: `${OUT_DIR}/${base}.png` }).catch(() => {})
        const outline = await page.locator("body").ariaSnapshot().catch((e) => `no outline: ${e}`)
        writeFileSync(`${OUT_DIR}/${base}.outline.txt`, `${page.url()}\n\n${outline}\n`)
        record.outline = `${base}.outline.txt`
        throw error
      }
    },
  }
  try {
    await run(ctx)
    if (pageErrors.length) throw new Error(`the page raised ${pageErrors.length} uncaught error(s): ${pageErrors[0]}`)
  } catch (error) {
    entry.ok = false
    entry.error = String(error).split("\n").slice(0, 8).join("\n")
  } finally {
    await context.close()
  }
  console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${name} @ ${width}${entry.ok ? "" : `\n        ${entry.error.replace(/\n/g, "\n        ")}`}`)
}

const available = readdirSync(`${HERE}journeys`).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort()
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : available
for (const name of names) if (!available.includes(name)) throw new Error(`unknown journey: ${name} (have: ${available.join(", ")})`)
const widths = (process.env.WIDTHS ?? "phone,desktop").split(",")

mkdirSync(OUT_DIR, { recursive: true })
// The bundled Chromium when it is installed, else the system Chrome.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }))
const report = []
try {
  for (const name of names) {
    const { default: run } = await import(`./journeys/${name}.mjs`)
    for (const width of widths) await runJourney(browser, name, run, width, report)
  }
} finally {
  await browser.close()
}
if (existsSync(`${DRIVE_DIR}/model.jsonl`)) copyFileSync(`${DRIVE_DIR}/model.jsonl`, `${OUT_DIR}/model-requests.jsonl`)
const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).toString().trim()
const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain"]).toString().trim() !== ""
writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify({ commit, dirty, widths: WIDTHS, results: report }, null, 2))
const failed = report.filter((r) => !r.ok)
console.log(`${report.length - failed.length} of ${report.length} passed; evidence: ${OUT_DIR}`)
process.exit(failed.length ? 1 : 0)

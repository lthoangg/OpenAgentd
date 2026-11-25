// Browser measurements of one or more production bundles against the perf
// sandbox (see run-browser.sh, which starts everything this needs).
//
//   ROOT=<repo> TARGETS=base=http://localhost:5197,head=http://localhost:5198 \
//   PROXY=http://127.0.0.1:8796 API=http://127.0.0.1:8794/api LONG=<id> WORK=<id> \
//   bun scripts/perf/browser_measure.mjs
//
// RUNS (default 7) cold opens per case, INTERACTIVE_RUNS (default 3) runs of
// the interaction scenario; ONLY=open,interactive picks scenarios
// and MATCH="session return" the cases whose name holds it; DELAYS (default
// 0,150,400) the API latencies; OUT is where the raw samples go as JSON.
//
// What keeps the numbers honest:
// - Every cold open is a new browser profile: no HTTP cache, no storage. A
//   "return" case visits once first and measures the second load in that
//   profile, which is what relaunching an app is: its settings and its
//   position on the event feed are there.
// - With several targets the runs alternate (base, head, base, head, …), so
//   a machine that warms up or gets busy moves both the same way.
// - Times come from inside the page: a MutationObserver sees each landmark
//   enter the document and stamps it right after the frame that drew it, in
//   a task that runs ahead of the app's own queued work (so rendering that
//   follows the paint is not counted into it). Nothing polls the DOM while
//   the clock runs. Each landmark is then checked once for being visible.
// - A delayed run fails unless every API response took at least the delay
//   and the proxy forwarded at least as many requests as the page finished.
// - Each figure is printed as median/min/max: a difference smaller than the
//   spread of either side is not a difference.
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import os from "node:os"
import { MARKER } from "./browser_seed.mjs"

const env = (name) => process.env[name] ?? (() => { throw new Error(`browser_measure: set ${name}`) })()
const { chromium } = createRequire(`${env("ROOT")}/scripts/readme-shots/`)("playwright/test")
const TARGETS = env("TARGETS").split(",").map((entry) => ({ label: entry.slice(0, entry.indexOf("=")), url: entry.slice(entry.indexOf("=") + 1) }))
const PROXY = env("PROXY")
const API = env("API")
const LONG = env("LONG")
// The interaction scenario sends messages: to this session, never to LONG.
const WORK = env("WORK")
const RUNS = Number(process.env.RUNS ?? 7)
const ONLY = (process.env.ONLY ?? "open,interactive").split(",")
const MATCH = process.env.MATCH ?? ""
const INTERACTIVE_RUNS = Number(process.env.INTERACTIVE_RUNS ?? 3)
const DELAYS = (process.env.DELAYS ?? "0,150,400").split(",").map(Number)

const PROFILES = {
  desktop: { context: { viewport: { width: 1440, height: 900 } }, cpu: 1 },
  "phone-4x": { context: { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true }, cpu: 4 },
}
/**
 * What each landmark is, for the one visibility check after its time is
 * taken. `marker` names the newest turn: `(chat): Final turn <marker>`.
 */
const LANDMARKS = {
  composer: (page) => page.getByRole("textbox", { name: "Message input" }),
  transcript: (page, marker) => page.getByText(`(chat): Final turn ${marker}`).first(),
  rows: (page) => page.getByText(/^Short session 299:/).first(),
  workspaces: (page) => page.getByRole("button", { name: "Open workspace demo" }),
}

const round = (x) => Math.round(x * 10) / 10
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => sorted(xs)[Math.floor(xs.length / 2)]
const quantile = (xs, q) => sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * q))]
const spread = (xs) => `${round(median(xs))}/${round(Math.min(...xs))}/${round(Math.max(...xs))}`

/** Runs in the page before the app: observers, and the landmark stamps. */
function init({ marker, watch }) {
  const perf = (window.__perf = { long: [], lcp: 0, frames: [], inputs: [], marks: {}, click: 0, raf: 0 })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.long.push([e.startTime, e.duration]) }).observe({ type: "longtask", buffered: true })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.lcp = e.startTime }).observe({ type: "largest-contentful-paint", buffered: true })
  const holds = (selector) => (node) => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector) !== null)
  const found = {
    composer: holds('textarea[aria-label="Message input"]'),
    transcript: (node) => (node.textContent ?? "").includes(`(chat): Final turn ${marker}`),
    rows: (node) => (node.textContent ?? "").includes("Short session 299:"),
    workspaces: holds('[aria-label="Open workspace demo"]'),
  }
  // Run `done` once the frame now starting has been drawn. Queued from that
  // frame's rAF at the highest task priority: an ordinary task the app queued
  // earlier (a timer that goes on to render for 50 ms) would otherwise run
  // first and be counted into the paint it follows.
  const afterFrame = (done) => requestAnimationFrame(() => {
    if (globalThis.scheduler?.postTask) {
      globalThis.scheduler.postTask(done, { priority: "user-blocking" })
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = done
    channel.port2.postMessage(0)
  })
  const stamp = (key) => afterFrame(() => { perf.marks[key] = performance.now() })
  let pending = []
  const observer = new MutationObserver((records) => {
    pending = pending.filter((key) => {
      for (const record of records) {
        for (const node of record.type === "characterData" ? [record.target] : record.addedNodes) {
          if (found[key](node)) { stamp(key); return false }
        }
      }
      return true
    })
    if (pending.length === 0) observer.disconnect()
  })
  /** Start (or restart) the clock for these landmarks. */
  perf.watch = (keys) => {
    for (const key of keys) delete perf.marks[key]
    pending = [...keys]
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  }
  perf.watch(watch)
  addEventListener("click", (e) => { perf.click = e.timeStamp }, true)
  // From an input event to the frame after it.
  addEventListener("input", (e) => {
    const at = e.timeStamp
    afterFrame(() => perf.inputs.push(performance.now() - at))
  }, true)
  perf.countFrames = (on) => {
    cancelAnimationFrame(perf.raf)
    if (!on) return
    perf.frames = []
    let last = performance.now()
    const tick = (now) => { perf.frames.push(now - last); last = now; perf.raf = requestAnimationFrame(tick) }
    perf.raf = requestAnimationFrame(tick)
  }
}

async function openContext(browser, profile, watch, marker = MARKER) {
  const context = await browser.newContext({ ...profile.context, reducedMotion: "reduce", deviceScaleFactor: 1 })
  await context.addInitScript(init, { marker, watch })
  return context
}

async function openPage(context, profile) {
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu })
  const taskSeconds = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value
  return { page, taskSeconds }
}

/** Wait for the landmarks' stamps without touching the DOM, then check each is on screen. */
async function landmarks(page, keys, marker = MARKER) {
  await page.waitForFunction((wanted) => wanted.every((key) => window.__perf.marks[key] > 0), keys, { polling: 100 }).catch(async () => {
    const marks = await page.evaluate(() => window.__perf.marks)
    throw new Error(`no ${keys.filter((key) => !(marks[key] > 0)).join(", ")} within 60 s at ${page.url()}`)
  })
  for (const key of keys) {
    if (!(await LANDMARKS[key](page, marker).isVisible())) throw new Error(`landmark "${key}" is in the document but not visible`)
  }
  return page.evaluate(() => ({ ...window.__perf.marks }))
}

async function setDelay(ms) {
  const res = await fetch(`${PROXY}/__delay/${ms}`, { method: "PUT" })
  if (!res.ok) throw new Error(`the delay proxy answered ${res.status}`)
}

/**
 * One cold open of `url` with every API request delayed by `delay` ms.
 * `returning`: after a first visit in the same profile (not measured).
 */
async function coldOpen(browser, profile, url, keys, delay, returning) {
  const context = await openContext(browser, profile, keys)
  try {
    if (returning) {
      await setDelay(0)
      const { page: first } = await openPage(context, profile)
      await first.goto(url, { waitUntil: "commit" })
      await landmarks(first, keys)
      await first.waitForTimeout(1500)
      const position = await first.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("oa-global-stream-cursor:")))
      if (!position) throw new Error("the first visit left no event-feed position: a return would measure a first open")
      await first.close()
    }
    await setDelay(delay)
    const { page } = await openPage(context, profile)
    await page.goto(url, { waitUntil: "commit" })
    const marks = await landmarks(page, keys)
    const last = Math.max(...keys.map((key) => marks[key]))
    // Requests the open still has out: let them finish so the count is whole.
    await page.waitForTimeout(1500 + delay * 8)
    const seen = await page.evaluate(() => ({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0,
      lcp: window.__perf.lcp,
      long: window.__perf.long,
      nodes: document.getElementsByTagName("*").length,
      api: performance.getEntriesByType("resource").filter((r) => new URL(r.name).pathname.startsWith("/api/"))
        .map((r) => ({ path: new URL(r.name).pathname, params: [...new URL(r.name).searchParams.keys()].sort().join("&"), issued: r.startTime, queued: r.requestStart - r.startTime, server: r.responseStart - r.requestStart, done: r.responseEnd })),
    }))
    const forwarded = (await (await fetch(`${PROXY}/__stats`)).json()).forwarded
    if (seen.api.length === 0) throw new Error("the page finished no API request")
    if (forwarded < seen.api.length) throw new Error(`the page finished ${seen.api.length} API requests but the proxy forwarded ${forwarded}: some did not go through it`)
    const fastest = Math.min(...seen.api.map((r) => r.server))
    if (delay > 0 && fastest < delay - 2) throw new Error(`an API response took ${round(fastest)} ms with a ${delay} ms delay: the delay did not apply`)
    return {
      ...Object.fromEntries(keys.map((key) => [`${key}_ms`, marks[key]])),
      fcp_ms: seen.fcp,
      lcp_ms: seen.lcp,
      // Main-thread time over 50 ms per task until the last landmark (TBT's definition).
      blocked_ms: seen.long.filter(([start]) => start < last).reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0),
      nodes: seen.nodes,
      requests: seen.api.length,
      requests_before_last_landmark: seen.api.filter((r) => r.issued < last).length,
      queued_max_ms: Math.max(...seen.api.map((r) => r.queued)),
      history_done_ms: seen.api.find((r) => r.path.endsWith("/history"))?.done ?? 0,
      // Every finished request in the order the page issued it; kept for the first run of a case.
      timeline: seen.api.sort((a, b) => a.issued - b.issued).map(({ params, ...r }) => ({ ...r, path: r.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id") + (params ? `?${params}` : "") })),
    }
  } finally {
    await context.close()
  }
}

async function sessionRunning() {
  const res = await fetch(`${API}/agent/sessions/${WORK}`)
  if (!res.ok) throw new Error(`GET the work session answered ${res.status}`)
  return (await res.json()).running === true
}

/** The newest turn of the work session: each interaction run adds one. */
let workMarker = MARKER
let workRuns = 0

/** Switching to the work session, typing in it, and a reply streaming into it. */
async function interactive(browser, profile, name, url) {
  await setDelay(0)
  const context = await openContext(browser, profile, ["transcript"], workMarker)
  const { page, taskSeconds } = await openPage(context, profile)
  const out = {}
  try {
    await page.goto(`${url}/${WORK}`, { waitUntil: "commit" })
    await landmarks(page, ["transcript"], workMarker)
    await page.waitForTimeout(2500)
    out.nodes = [await page.evaluate(() => document.getElementsByTagName("*").length)]
    // Nothing happening for five seconds.
    let before = await taskSeconds()
    await page.waitForTimeout(5000)
    out.idle_5s_task_ms = [((await taskSeconds()) - before) * 1e3]
    // Switch away and back by the sidebar (the phone has no sidebar beside a chat).
    if (name === "desktop") {
      out.switch_ms = []
      for (let i = 0; i < 5; i++) {
        // The sidebar lists a few recent rows per workspace: any short session does.
        await page.getByRole("complementary").getByRole("button", { name: /^Short session \d+:/ }).first().click()
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.__perf.watch(["transcript"]))
        await page.getByRole("complementary").getByRole("button", { name: /^Work session: refactor/ }).first().click()
        const marks = await landmarks(page, ["transcript"], workMarker)
        out.switch_ms.push(marks.transcript - (await page.evaluate(() => window.__perf.click)))
        await page.waitForTimeout(800)
      }
    }
    // 150 characters into the composer, 25 a second.
    const box = LANDMARKS.composer(page)
    await box.click()
    await page.evaluate(() => { window.__perf.inputs = []; window.__perf.long = [] })
    await page.keyboard.type("the quick brown fox jumps over the lazy dog and keeps typing a rather long message for the agent to read ".repeat(2).slice(0, 150), { delay: 40 })
    await page.waitForTimeout(300)
    let seen = await page.evaluate(() => ({ inputs: window.__perf.inputs, long: window.__perf.long }))
    if (seen.inputs.length !== 150) throw new Error(`typed 150 characters, the page saw ${seen.inputs.length} input events`)
    out.typing_frame_p50_ms = [quantile(seen.inputs, 0.5)]
    out.typing_frame_p95_ms = [quantile(seen.inputs, 0.95)]
    out.typing_frame_max_ms = [Math.max(...seen.inputs)]
    out.typing_long_tasks = [seen.long.length]
    await box.fill("")
    // A Markdown reply of about 420 words, streamed by the stub a word every 20 ms.
    const part = (i) => `Part ${i} ${name}: what changed.\n\n- rounding happens once, at the invoice level\n- tax lines keep **four** decimals until the total\n\n\`\`\`rust\nfn round_invoice(x: f64) -> f64 {\n    (x * 100.0).round() / 100.0\n}\n\`\`\`\n\n| line | before | after |\n|---|---|---|\n| tax | 1.2345 | 1.23 |\n\nThe remaining edge cases are covered by the tests above, and nothing else in the module reads the old field.`
    const runMarker = `run-${++workRuns}-${Date.now().toString(36)}`
    const prompt = `Final turn ${runMarker}\n\n${Array.from({ length: 6 }, (_, i) => part(i)).join("\n\n")}`
    await box.fill(prompt)
    await page.evaluate(() => { window.__perf.long = []; window.__perf.countFrames(true) })
    before = await taskSeconds()
    const started = Date.now()
    await page.getByRole("button", { name: "Send message" }).click()
    let ran = false
    for (let i = 0; i < 1200; i++) {
      if (await sessionRunning()) ran = true
      else if (ran) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!ran) throw new Error("the turn never showed as running")
    workMarker = runMarker
    const wall = Date.now() - started
    const task = ((await taskSeconds()) - before) * 1e3
    seen = await page.evaluate(() => { window.__perf.countFrames(false); return { frames: window.__perf.frames, long: window.__perf.long } })
    out.stream_wall_ms = [wall]
    out.stream_busy_pct = [(task / wall) * 100]
    out.stream_frame_p95_ms = [quantile(seen.frames, 0.95)]
    out.stream_frame_max_ms = [Math.max(...seen.frames)]
    out.stream_frames_over_50ms = [seen.frames.filter((f) => f > 50).length]
    out.stream_frames = [seen.frames.length]
    out.stream_long_task_ms = [seen.long.reduce((sum, [, duration]) => sum + duration, 0)]
    return out
  } finally {
    await context.close()
  }
}

const results = { meta: { at: new Date().toISOString(), runs: RUNS, cores: os.cpus().length, load_before: os.loadavg()[0], targets: TARGETS }, cases: {}, timelines: {} }
const record = (name, label, sample) => {
  const { timeline, ...figures } = sample
  if (timeline) (results.timelines[name] ??= {})[label] ??= timeline
  const byLabel = ((results.cases[name] ??= {})[label] ??= {})
  for (const [key, value] of Object.entries(figures)) (byLabel[key] ??= []).push(...[value].flat())
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }))
results.meta.browser = `${browser.browserType().name()} ${browser.version()}`
if (results.meta.load_before > results.meta.cores / 2) console.error(`browser_measure: the machine is busy (load ${round(results.meta.load_before)} on ${results.meta.cores} cores); the numbers will be noisy`)
try {
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (ONLY.includes("open")) {
      // Home: the composer on a desktop, the list of workspaces on a phone.
      const sessionKeys = name === "desktop" ? ["composer", "transcript", "rows"] : ["composer", "transcript"]
      const pages = [
        ["home", "/", name === "desktop" ? ["composer"] : ["workspaces"], [0], false],
        ["session", `/${LONG}`, sessionKeys, DELAYS, false],
        ["session return", `/${LONG}`, sessionKeys, DELAYS, true],
      ]
      for (const [pageName, path, keys, delays, returning] of pages) {
        for (const delay of delays) {
          const caseName = `open ${name} ${pageName} delay=${delay}`
          if (!caseName.includes(MATCH)) continue
          for (let run = 0; run < RUNS; run++) {
            for (const target of TARGETS) record(caseName, target.label, await coldOpen(browser, profile, target.url + path, keys, delay, returning))
          }
        }
      }
    }
    if (ONLY.includes("interactive") && `interactive ${name}`.includes(MATCH)) {
      // Each run sends a message, so the long session grows by a turn a run:
      // alternating keeps the targets a turn apart at most.
      for (let run = 0; run < INTERACTIVE_RUNS; run++) {
        for (const target of TARGETS) record(`interactive ${name}`, target.label, await interactive(browser, profile, name, target.url))
      }
    }
  }
} finally {
  await browser.close()
  await setDelay(0)
  results.meta.load_after = os.loadavg()[0]
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 2))
  report()
}


// One line per case and target, each figure as median/min/max; then, with two
// targets, how the second compares with the first on the times. Printed even
// when a later step fails, so the cases already measured are not lost.
function report() {
  for (const [name, byLabel] of Object.entries(results.cases)) {
    for (const [label, samples] of Object.entries(byLabel)) {
      const n = Math.max(...Object.values(samples).map((xs) => xs.length))
      console.log(`BENCH [${label}] ${name} ${Object.entries(samples).map(([key, xs]) => `${key}=${xs.length > 1 ? spread(xs) : round(xs[0])}`).join(" ")} n=${n}`)
    }
    const [a, b] = TARGETS.map((target) => byLabel[target.label])
    if (TARGETS.length === 2 && a && b) {
      const changes = Object.keys(a).filter((key) => key.endsWith("_ms") && median(a[key]) > 0).map((key) => {
        const from = median(a[key])
        const to = median(b[key])
        // Outside both spreads: every run of one side is faster than every run of the other.
        const clear = Math.max(...b[key]) < Math.min(...a[key]) || Math.min(...b[key]) > Math.max(...a[key])
        return `${key} ${round(from)}→${round(to)} (${to >= from ? "+" : ""}${Math.round(((to - from) / from) * 100)}%${clear ? "" : ", within spread"})`
      })
      console.log(`DIFF  ${name}: ${changes.join("; ")}`)
    }
  }
}

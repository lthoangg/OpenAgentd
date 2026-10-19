// Capture the README screenshots from the sandbox started by `run.sh up` + `run.sh stage`.
//
//   bun capture.mjs                 every scene, light + dark
//   bun capture.mjs hero plan       only these scenes
//   THEMES=light bun capture.mjs    one theme
//
// Writes <OUT_DIR>/<scene>-<theme>.webp (PNG intermediates stay in $SHOTS_DIR/raw).
import { chromium } from "playwright"
import { mkdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const SHOTS_DIR = process.env.SHOTS_DIR ?? "/tmp/oad-demo"
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5199"
const OUT_DIR = process.env.OUT_DIR ?? `${SHOTS_DIR}/out`
const THEMES = (process.env.THEMES ?? "light,dark").split(",")
const RAW_DIR = `${SHOTS_DIR}/raw`
const S = JSON.parse(readFileSync(`${SHOTS_DIR}/sessions.json`, "utf8"))

const DESKTOP = { width: 1600, height: 1000 }
const PHONE = { width: 402, height: 874 }
const BANNER_DIR = new URL("../../documents/assets/brand/banner/", import.meta.url).pathname

const mod = process.platform === "darwin" ? "Meta" : "Control"
const settle = (page, ms = 900) => page.waitForTimeout(ms)

async function open(page, path) {
  await page.goto(WEB_URL + path, { waitUntil: "load" })
  await page.getByRole("main").waitFor()
  await settle(page, 2500)
}

async function runCommand(page, label) {
  await page.keyboard.press(`${mod}+K`)
  await page.getByRole("dialog").waitFor()
  await page.keyboard.type(label, { delay: 15 })
  await settle(page, 400)
  await page.keyboard.press("Enter")
  await settle(page)
}

/** Reader mode folds each finished turn to its answer: the cleanest transcript to show. */
async function readerMode(page) {
  await runCommand(page, "Toggle Reader Mode")
}

async function scrollTranscriptToEnd(page) {
  // Twice: late-rendering rows (diff stats, code blocks) grow the transcript after the first jump.
  for (let i = 0; i < 2; i++) {
    await page.getByRole("main").evaluate((el) => {
      for (const n of el.querySelectorAll("*")) if (n.scrollHeight > n.clientHeight + 40) n.scrollTop = n.scrollHeight
    })
    await settle(page, 800)
  }
}

/** Drop keyboard focus so no focus ring lands in the shot. */
async function blur(page) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.mouse.move(0, 0)
  await settle(page, 300)
}

/** Click if present (UI that is already open, e.g. an auto-expanded sidebar row, is fine). */
async function tryClick(locator) {
  try {
    await locator.first().click({ timeout: 2500 })
  } catch {}
}

// Each scene leaves the page in the state to photograph.
const scenes = {
  async hero(page) {
    await open(page, `/${S.hero}`)
    // The BTW chip floats over the transcript and would cover the agent's last
    // line; the btw scene shows the feature itself.
    await page.addStyleTag({ content: 'button[aria-label^="Show side questions"] { visibility: hidden }' })
    await runCommand(page, "Open Git")
    await page.getByText("src/server.ts", { exact: true }).last().click()
    await settle(page)
    await scrollTranscriptToEnd(page)
    await blur(page)
  },

  async plan(page) {
    await open(page, `/${S.plan}`)
    await runCommand(page, "Open Plan")
    await settle(page, 1200)
    await blur(page)
  },

  async subagents(page) {
    await open(page, `/${S.audit}`)
    await tryClick(page.getByRole("button", { name: /Expand \d+ subagents?/ }))
    await settle(page)
    await scrollTranscriptToEnd(page)
    await blur(page)
  },

  async palette(page) {
    await open(page, `/${S.hero}`)
    await runCommand(page, "Open Git")
    await scrollTranscriptToEnd(page)
    await page.keyboard.press(`${mod}+K`)
    await page.getByRole("dialog").waitFor()
    await settle(page, 600)
  },

  async btw(page) {
    await open(page, `/${S.hero}`)
    await page.getByRole("button", { name: /Show side questions/ }).click()
    await settle(page, 1200)
    await scrollTranscriptToEnd(page)
    await blur(page)
  },

  async terminal(page) {
    await open(page, `/${S.hero}`)
    await runCommand(page, "Open Terminal")
    const term = page.locator(".xterm").first()
    await term.waitFor()
    await settle(page, 1500)
    await term.click()
    // Neutral prompt: zsh's default prints the machine's user and host names.
    await page.keyboard.type("PS1='%F{8}linkly%f %# '; clear", { delay: 5 })
    await page.keyboard.press("Enter")
    await settle(page, 600)
    await page.keyboard.type("bun test", { delay: 40 })
    await page.keyboard.press("Enter")
    await settle(page, 3500)
    await scrollTranscriptToEnd(page)
    await page.mouse.move(0, 0)
  },

  async telemetry(page) {
    await open(page, `/${S.hero}`)
    await runCommand(page, "Open Telemetry")
    await settle(page, 2500)
    await blur(page)
  },

  async providers(page) {
    await open(page, `/${S.hero}`)
    await runCommand(page, "Open Settings")
    await page.getByRole("dialog").getByText("Providers", { exact: true }).first().click()
    // The OAuth filter shows subscription logins (Copilot, Codex, Grok) and avoids
    // the usage panel of connected API-key providers, which never resolves for plain keys.
    await page.getByRole("dialog").getByRole("button", { name: /^OAuth/ }).first().click()
    await settle(page, 1200)
    await blur(page)
  },

  async "new-session"(page) {
    await open(page, `/${S.hero}`)
    await page.getByRole("button", { name: "New session in linkly" }).click()
    await settle(page, 1500)
    await blur(page)
  },

  phone: Object.assign(
    async (page) => {
      await open(page, `/${S.hero}`)
      await scrollTranscriptToEnd(page)
      await blur(page)
    },
    { viewport: PHONE },
  ),

  // Source image for documents/assets/brand/banner/banner.html: transcript + diff, no sidebar.
  "banner-shot": Object.assign(
    async (page) => {
      await open(page, `/${S.hero}`)
      await runCommand(page, "Toggle Sidebar")
      await runCommand(page, "Open Git")
      await page.getByText("src/server.ts", { exact: true }).last().click()
      await settle(page)
      await scrollTranscriptToEnd(page)
      await blur(page)
    },
    { viewport: { width: 1280, height: 820 }, outDir: BANNER_DIR },
  ),
}

function toWebp(src, dest) {
  const r = spawnSync("cwebp", ["-quiet", "-q", "88", "-m", "6", src, "-o", dest])
  if (r.status !== 0) throw new Error(`cwebp failed for ${src}`)
}

// Tour shots sit two to a row in the README, so crop each to what it is about.
// All 16:10, in CSS px of the 1600x1000 desktop viewport.
// Starting at the sidebar's border (x=264) and below the app header (y=37) keeps real UI edges
// on the crop instead of cut-off words.
const MAIN = { x: 264, y: 37, width: 1336, height: 835 } // transcript + review dock
const DIALOG = { x: 180, y: 56, width: 1240, height: 775 } // centred overlays (Settings, Telemetry)
const CROPS = {
  plan: MAIN,
  btw: MAIN,
  terminal: MAIN,
  palette: MAIN,
  telemetry: DIALOG,
  providers: DIALOG,
  subagents: { x: 0, y: 156, width: 1350, height: 844 },
  "new-session": { x: 0, y: 56, width: 1300, height: 812 },
}

mkdirSync(RAW_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const names = wanted.length ? wanted : Object.keys(scenes)
const browser = await chromium.launch()
try {
  for (const name of names) {
    const scene = scenes[name]
    if (!scene) throw new Error(`unknown scene: ${name}`)
    for (const theme of THEMES) {
      const viewport = scene.viewport ?? DESKTOP
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" })
      // Headless screenshots miss xterm's WebGL canvas; without WebGL it falls back to the DOM renderer.
      await ctx.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          return type === "webgl2" || type === "webgl" ? null : getContext.call(this, type, ...rest)
        }
      })
      const page = await ctx.newPage()
      await scene(page)
      const raw = `${RAW_DIR}/${name}-${theme}.png`
      await page.screenshot({ path: raw, clip: CROPS[name] })
      toWebp(raw, `${scene.outDir ?? OUT_DIR}/${name}-${theme}.webp`)
      console.log(`  ✓ ${name}-${theme}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}

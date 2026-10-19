// Render the README banner (light + dark) and the GitHub social preview from
// documents/assets/brand/banner/banner.html. Run after `run.sh capture`, since the
// banner embeds the `banner-shot` capture.
// Fonts come from web/node_modules (run `bun install --cwd web` first).
//
//   bun scripts/readme-shots/banner.mjs
import { chromium } from "playwright"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const BRAND = path.join(ROOT, "documents/assets/brand")
const SRC = pathToFileURL(path.join(BRAND, "banner/banner.html")).href

const outputs = [
  // README banner: 1600x640 CSS px at 2x, transparent corners.
  { query: "theme=light", file: "openagentd-banner-light.webp", scale: 2 },
  { query: "theme=dark", file: "openagentd-banner-dark.webp", scale: 2 },
  // GitHub social preview (Settings → General): 1280x640, PNG, under 1 MB.
  { query: "theme=light&layout=social", file: "openagentd-social-preview.png", scale: 1, opaque: true },
]

const browser = await chromium.launch()
try {
  for (const o of outputs) {
    const page = await browser.newPage({ deviceScaleFactor: o.scale, viewport: { width: 1700, height: 800 } })
    await page.goto(`${SRC}?${o.query}`)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))
    const canvas = page.locator("#canvas")
    if (o.opaque) await canvas.evaluate((el) => (el.style.borderRadius = "0"))
    const out = path.join(BRAND, o.file)
    if (out.endsWith(".webp")) {
      const raw = out.replace(/\.webp$/, ".png")
      await canvas.screenshot({ path: raw, omitBackground: true })
      const r = spawnSync("cwebp", ["-quiet", "-q", "90", "-m", "6", "-alpha_q", "100", raw, "-o", out])
      spawnSync("rm", ["-f", raw])
      if (r.status !== 0) throw new Error(`cwebp failed for ${raw}`)
    } else {
      await canvas.screenshot({ path: out })
    }
    console.log(`  ✓ ${o.file}`)
    await page.close()
  }
} finally {
  await browser.close()
}

// Build the OpenAgentd logo from the Schibsted Grotesk font and write every
// brand file the app, the platform icons, the README, and openagentd.dev use.
// Run `bun install --cwd scripts/brand && bun scripts/brand/brand.ts` after
// changing the geometry below or web/src/lib/brand/logo.css, then
// `python3 scripts/generate_icons.py --force`. Needs Playwright's Chromium for
// the PNGs, Pillow (python3) for the opaque iOS master, and ffmpeg for the
// intro video (skipped if ffmpeg is missing).
//
// The logo has two forms:
// - The Seal: an ink disc with an open A (no crossbar) cut out of it and a
//   Signal Blue dot as the crossbar. The dot is the agent. Icons and cards.
// - The wordmark: "OpenAgentd" in Schibsted Grotesk 600, with the font's A
//   replaced by the same open A and dot.
// The intro animation turns the Seal into the wordmark (logo.css).
//
// Writes:
// - web/src/lib/brand/logo-data.ts: the outlines, used by the app's Logo.tsx
//   and (synced) by openagentd.dev.
// - documents/assets/brand/logo/: the Seal and wordmark as SVG and PNG (light
//   and dark), the animated intro as SVG, MP4, and GIF.
// - documents/assets/brand/web/: favicon.svg, favicon.png (64),
//   favicon-192.png, apple-touch-icon.png; the app's copies in web/public/.
// - documents/assets/brand/icons/ and openagentd-app-icon.png: the platform
//   icon masters that scripts/generate_icons.py turns into native icons.
// - web/index.html: the boot loader's inline Seal, between its markers.
//
// The font is the OFL variable TTF (fonts/, with its license): fontkit cannot
// apply variations to WOFF2 files.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fontkit from 'fontkit';
import { chromium } from 'playwright';

const root = join(import.meta.dir, '../..');
const WORD = 'OpenAgentd';
const A_INDEX = 4;
const WEIGHT = 600;
const TRACKING = -0.02; // em
const EM = 1000; // the wordmark's units per em

// The Seal on its 64-unit grid (approved in the logo exploration).
const GRID = { cx: 32, cy: 32, disc: 27, apex: 20, base: 47, half: 11.5, sw: 6, dotY: 39, dot: 3.75 };

const r1 = (n: number) => Math.round(n * 10) / 10;
const pt = (x: number, y: number) => `${r1(x)} ${r1(y)}`;

/** The open A as one closed outline: a stroked chevron with a round apex,
 * its legs cut flat at the baseline. The centre line meets the baseline at
 * cx ± half. */
function openA(cx: number, apex: number, base: number, half: number, sw: number): string {
  const w = sw / 2;
  const h = base - apex;
  const len = Math.hypot(half, h);
  const u = { x: half / len, y: h / len }; // apex to right foot; mirror for the left
  const n = { x: h / len, y: -half / len }; // the right leg's outward normal
  const footAt = (ox: number, oy: number, dirX: number) => {
    const t = (base - oy) / u.y;
    return [ox + dirX * u.x * t, base] as const;
  };
  const outerL = [cx - w * n.x, apex + w * n.y] as const;
  const outerR = [cx + w * n.x, apex + w * n.y] as const;
  const footOL = footAt(outerL[0], outerL[1], -1);
  const footOR = footAt(outerR[0], outerR[1], 1);
  const innerL = [cx + w * n.x, apex - w * n.y] as const;
  const innerR = [cx - w * n.x, apex - w * n.y] as const;
  const footIL = footAt(innerL[0], innerL[1], -1);
  const footIR = footAt(innerR[0], innerR[1], 1);
  const crotch = apex - w * n.y + ((w * n.x) / u.x) * u.y;
  return [
    `M${pt(...footOL)}`,
    `L${pt(...outerL)}`,
    `A${r1(w)} ${r1(w)} 0 0 1 ${pt(...outerR)}`,
    `L${pt(...footOR)}`,
    `L${pt(...footIR)}`,
    `L${pt(cx, crotch)}`,
    `L${pt(...footIL)}`,
    'Z',
  ].join('');
}

const circle = (cx: number, cy: number, r: number) =>
  `M${pt(cx - r, cy)}A${r1(r)} ${r1(r)} 0 1 0 ${pt(cx + r, cy)}A${r1(r)} ${r1(r)} 0 1 0 ${pt(cx - r, cy)}Z`;

// --- The font ---------------------------------------------------------------

const font = fontkit.openSync(join(root, 'scripts/brand/fonts/SchibstedGrotesk-wght.ttf')) as fontkit.Font & {
  variationCoords: number[];
  unitsPerEm: number;
  capHeight: number;
};
font.variationCoords = [WEIGHT];
const S = EM / font.unitsPerEm;

type Cmd = { command: string; args: number[] };
function glyphPath(glyph: fontkit.Glyph, x: number): string {
  return (glyph.path.commands as Cmd[])
    .map(({ command, args }) => {
      const p = [];
      for (let i = 0; i < args.length; i += 2) p.push(pt(x + args[i]! * S, -args[i + 1]! * S));
      switch (command) {
        case 'moveTo': return `M${p[0]}`;
        case 'lineTo': return `L${p[0]}`;
        case 'quadraticCurveTo': return `Q${p.join(' ')}`;
        case 'bezierCurveTo': return `C${p.join(' ')}`;
        default: return 'Z';
      }
    })
    .join('');
}

const run = font.layout(WORD);
let pen = 0;
let minY = 0;
let maxY = 0;
let minX = Infinity;
let maxX = -Infinity;
const placed = run.glyphs.map((glyph, i) => {
  const x = pen;
  pen += run.positions[i]!.xAdvance * S + TRACKING * EM;
  const box = glyph.path.bbox;
  minX = Math.min(minX, x + box.minX * S);
  maxX = Math.max(maxX, x + box.maxX * S);
  minY = Math.min(minY, -box.maxY * S);
  maxY = Math.max(maxY, -box.minY * S);
  return { glyph, x, box };
});

// --- The wordmark's open A, fitted to the font's A --------------------------

const fontA = placed[A_INDEX]!;
const cap = font.capHeight * S;
// The stem weight: the width of H's left stem (its two leftmost x positions;
// H is drawn with straight lines only).
const hXs = [...new Set((font.glyphForCodePoint(0x48).path.commands as Cmd[]).flatMap((c) => c.args.filter((_, i) => i % 2 === 0)))].sort((a, b) => a - b);
const stem = (hXs[1]! - hXs[0]!) * S;
const sw = stem * 1.04;
const inkL = fontA.x + fontA.box.minX * S;
const inkR = fontA.x + fontA.box.maxX * S;
const A = { cx: (inkL + inkR) / 2, apex: -cap + sw * 0.55, base: 0, half: (inkR - inkL) / 2 - sw * 0.62 };
const aH = A.base - A.apex;
// The dot fills the same share of the gap between the legs as in the Seal.
const DOT_F = (GRID.dotY - GRID.apex) / (GRID.base - GRID.apex);
const gap = DOT_F * A.half - ((sw / 2) * Math.hypot(aH, A.half)) / aH;
const dot = { cx: A.cx, cy: A.apex + aH * DOT_F, r: gap * 0.77 };

// The Seal sits over the A during the intro. At scale 1 its A has the
// wordmark A's height, centred on it.
const sealK = aH / (GRID.base - GRID.apex);
const anchor = { x: A.cx, y: (A.apex + A.base) / 2 };
const gridMid = (GRID.apex + GRID.base) / 2;

const gridA = openA(GRID.cx, GRID.apex, GRID.base, GRID.half, GRID.sw);

const data = {
  em: EM,
  // The wordmark's ink box: [x, y, width, height], baseline at y = 0.
  viewBox: [r1(minX), r1(minY), r1(maxX - minX), r1(maxY - minY)],
  letters: placed
    .filter((_, i) => i !== A_INDEX)
    .map(({ glyph, x }) => {
      const i = placed.findIndex((p) => p.x === x);
      return { d: glyphPath(glyph, x), side: i < A_INDEX ? 'left' : 'right', dist: Math.abs(i - A_INDEX) };
    }),
  a: openA(A.cx, A.apex, A.base, A.half, sw),
  dot: { cx: r1(dot.cx), cy: r1(dot.cy), r: r1(dot.r) },
  seal: {
    grid: 64,
    // The disc with the A cut out (fill-rule evenodd), the A alone, the dot.
    disc: circle(GRID.cx, GRID.cy, GRID.disc) + gridA,
    a: gridA,
    dot: { cx: GRID.cx, cy: GRID.dotY, r: GRID.dot },
    // Where the Seal sits over the wordmark's A, and at what scale.
    anchor: { x: r1(anchor.x), y: r1(anchor.y) },
    transform: `scale(${Math.round(sealK * 1000) / 1000}) translate(-${GRID.cx} -${gridMid})`,
    discR: GRID.disc,
  },
};

writeFileSync(
  join(root, 'web/src/lib/brand/logo-data.ts'),
  `// Generated by scripts/brand/brand.ts; do not edit by hand.\n` +
    `// Schibsted Grotesk ${WEIGHT}, ${TRACKING}em tracking, ${EM} units per em.\n` +
    `export const LOGO = ${JSON.stringify(data, null, 2)} as const;\n`,
);
console.log('wrote web/src/lib/brand/logo-data.ts');

// --- Files ------------------------------------------------------------------

const { sealSvg, wordmarkSvg, PAPER } = await import('../../web/src/lib/brand/logo-svg');
const css = readFileSync(join(root, 'web/src/lib/brand/logo.css'), 'utf8');
const assetsDir = join(root, 'documents/assets/brand');
const brandDir = join(assetsDir, 'logo');
const webDir = join(assetsDir, 'web');
const iconsDir = join(assetsDir, 'icons');
const appPublic = join(root, 'web/public');
rmSync(brandDir, { recursive: true, force: true });
mkdirSync(brandDir, { recursive: true });
mkdirSync(webDir, { recursive: true });
mkdirSync(iconsDir, { recursive: true });

// Standalone SVGs carry their own colors (and, for the intro, the animation),
// so they work as images anywhere: a README, slides, the app.
const standalone = (svg: string, mode: 'light' | 'dark' | 'auto', withCss = false) => {
  const pal = PAPER[mode === 'auto' ? 'light' : mode];
  const colors =
    `svg{color:${pal.ink};--signal:${pal.signal}}.oad-logo{fill:currentColor}.oad-signal{fill:var(--signal)}` +
    (mode === 'auto'
      ? `@media (prefers-color-scheme:dark){svg{color:${PAPER.dark.ink};--signal:${PAPER.dark.signal}}}`
      : '');
  const style = `<style>${colors}${withCss ? css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ') : ''}</style>`;
  return svg.replace(/^<svg([^>]*)>/, `<svg xmlns="http://www.w3.org/2000/svg"$1>${style}`);
};

const files: Record<string, string> = {};
for (const mode of ['light', 'dark'] as const) {
  files[`openagentd-seal-${mode}.svg`] = standalone(sealSvg({ title: 'OpenAgentd' }), mode);
  files[`openagentd-wordmark-${mode}.svg`] = standalone(wordmarkSvg({ title: 'OpenAgentd' }), mode, true);
  files[`openagentd-intro-${mode}.svg`] = standalone(
    wordmarkSvg({ title: 'OpenAgentd', intro: 'load', id: 'intro', pad: true }),
    mode,
    true,
  );
}
for (const [name, svg] of Object.entries(files)) writeFileSync(join(brandDir, name), `${svg}\n`);
// The tab icon follows the browser's color scheme.
writeFileSync(join(webDir, 'favicon.svg'), `${standalone(sealSvg({}), 'auto')}\n`);
console.log(`wrote documents/assets/brand/logo/ (${Object.keys(files).length} SVGs) and web/favicon.svg`);

// The app's boot loader shows the Seal before React or any stylesheet loads,
// so web/index.html carries it inline (colored by its own <style>).
const indexHtml = join(root, 'web/index.html');
const START = '<!-- brand:seal:start -->';
const END = '<!-- brand:seal:end -->';
const html = readFileSync(indexHtml, 'utf8');
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < from) throw new Error(`web/index.html is missing the ${START} … ${END} markers`);
const bootSeal =
  `<svg class="app-boot-loader__logo" viewBox="0 0 64 64" width="88" height="88" aria-hidden="true" focusable="false">` +
  `<path fill-rule="evenodd" d="${data.seal.disc}"/>` +
  `<circle class="app-boot-loader__dot" cx="${data.seal.dot.cx}" cy="${data.seal.dot.cy}" r="${data.seal.dot.r}"/></svg>`;
writeFileSync(indexHtml, html.slice(0, from + START.length) + bootSeal + html.slice(to));
console.log('wrote the boot loader Seal in web/index.html');

// --- PNGs and video ---------------------------------------------------------

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(file: string, size: [number, number], svg: string, bg: string, inset = 0) {
  await page.setViewportSize({ width: size[0], height: size[1] });
  await page.setContent(
    `<!doctype html><style>*{margin:0}html,body{width:100%;height:100%;background:${bg}}` +
      `body{display:grid;place-items:center}svg{width:${size[0] - 2 * inset}px;height:${size[1] - 2 * inset}px}</style>${svg}`,
  );
  await page.screenshot({ path: file, omitBackground: bg === 'transparent' });
}

for (const mode of ['light', 'dark'] as const) {
  const seal = files[`openagentd-seal-${mode}.svg`]!;
  for (const px of [512, 1024]) await png(join(brandDir, `openagentd-seal-${mode}-${px}.png`), [px, px], seal, 'transparent');
}
// Tab icons: the light Seal on a transparent ground (Safari and older
// browsers; the others use favicon.svg). The home-screen icon needs an opaque
// square, so it is the Seal on paper.
const light = files['openagentd-seal-light.svg']!;
await png(join(webDir, 'favicon.png'), [64, 64], light, 'transparent');
await png(join(webDir, 'favicon-192.png'), [192, 192], light, 'transparent');
await png(join(webDir, 'apple-touch-icon.png'), [180, 180], light, PAPER.light.bg, 22);
for (const name of ['favicon.svg', 'favicon.png', 'apple-touch-icon.png']) copyFileSync(join(webDir, name), join(appPublic, name));
console.log('wrote the Seal PNGs and the favicons (documents/assets/brand/web/, copies in web/public/)');

// --- Platform icon masters ----------------------------------------------------
// 1024 px PNGs that scripts/generate_icons.py hands to `cargo tauri icon`.
// All use the light Paper colors: the ink Seal on a Paper tile.

const INK = PAPER.light.ink;
const SIGNAL = PAPER.light.signal;
const HAIRLINE = '#d9cfa9';
const sealAt = (x: number, y: number, size: number) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 64 64">` +
  `<path fill-rule="evenodd" fill="${INK}" d="${data.seal.disc}"/>` +
  `<circle fill="${SIGNAL}" cx="${data.seal.dot.cx}" cy="${data.seal.dot.cy}" r="${data.seal.dot.r}"/></svg>`;
const centred = (canvas: number, size: number) => sealAt((canvas - size) / 2, (canvas - size) / 2, size);
const tile = (inset: number, rx: number) =>
  `<rect x="${inset + 2}" y="${inset + 2}" width="${1024 - 2 * inset - 4}" height="${1024 - 2 * inset - 4}" rx="${rx}" ` +
  `fill="${PAPER.light.bg}" stroke="${HAIRLINE}" stroke-width="4"/>`;
const svg1024 = (body: string, viewBox = '0 0 1024 1024') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="1024" height="1024">${body}</svg>`;

async function master(file: string, size: number, svg: string, bg = 'transparent') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><style>*{margin:0}html,body{background:${bg}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: file, omitBackground: bg === 'transparent' });
}

// macOS (and Linux): Apple's grid, an 824 px tile at a 100 px inset.
await master(join(iconsDir, 'openagentd-icon-macos.png'), 1024, svg1024(tile(100, 185) + centred(1024, 560)));
// Windows: a full-bleed tile, so the 16-32 px taskbar sizes stay legible.
await master(join(iconsDir, 'openagentd-icon-windows.png'), 1024, svg1024(tile(16, 180) + centred(1024, 720)));
// Android adaptive foreground: 1024 px = 108 dp; the disc (58 dp) sits inside
// the 66 dp safe zone. The background is the Paper color (mobile-icons.json).
await master(join(iconsDir, 'openagentd-icon-android-foreground.png'), 1024, svg1024(centred(1024, 652)));
// macOS menu bar template (only alpha counts): the open A and the dot, no
// disc, which is too heavy at 18 pt and would merge the dot into the legs.
await master(
  join(iconsDir, 'openagentd-tray-template.png'),
  64,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 14 36 36"><path fill="#000" d="${data.seal.a}"/>` +
    `<circle fill="#000" cx="${data.seal.dot.cx}" cy="${data.seal.dot.cy}" r="${data.seal.dot.r}"/></svg>`,
);
// iOS (and SideStore, Android legacy icons): opaque, full-bleed Paper; the
// system applies the mask. The App Store rejects an alpha channel, so drop it.
const iosMaster = join(assetsDir, 'openagentd-app-icon.png');
await master(iosMaster, 1024, svg1024(`<rect width="1024" height="1024" fill="${PAPER.light.bg}"/>` + centred(1024, 600)), PAPER.light.bg);
execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[1])', iosMaster]);
writeFileSync(
  join(iconsDir, 'mobile-icons.json'),
  `${JSON.stringify({ default: '../openagentd-app-icon.png', bg_color: PAPER.light.bg.toUpperCase(), android_fg: 'openagentd-icon-android-foreground.png' }, null, 2)}\n`,
);
console.log('wrote the platform icon masters (documents/assets/brand/icons/, openagentd-app-icon.png)');

// The intro, frame by frame: CSS animations are paused and stepped with the
// Web Animations API, so the video matches the SVG exactly.
let ffmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
  console.warn('ffmpeg not found: skipped the intro video');
}
if (ffmpeg) {
  const W = 1280;
  const H = 720;
  const FPS = 30;
  const PLAY = 3.3;
  const HOLD = 1.5;
  for (const mode of ['light', 'dark'] as const) {
    const frames = join(tmpdir(), `oad-intro-${mode}`);
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(
      `<!doctype html><style>*{margin:0}body{width:${W}px;height:${H}px;display:grid;place-items:center;background:${PAPER[mode].bg}}` +
        `svg{width:${Math.round(W * 0.56)}px;height:auto}</style>${files[`openagentd-intro-${mode}.svg`]}`,
    );
    const total = Math.round((PLAY + HOLD) * FPS);
    for (let f = 0; f < total; f++) {
      await page.evaluate((ms) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = ms;
        }
      }, Math.min(f / FPS, PLAY) * 1000);
      await page.screenshot({ path: join(frames, `${String(f).padStart(4, '0')}.png`) });
    }
    const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%04d.png')];
    execFileSync('ffmpeg', [
      ...input,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart',
      join(brandDir, `openagentd-intro-${mode}.mp4`),
    ]);
    execFileSync('ffmpeg', [
      ...input,
      '-vf', 'fps=25,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none',
      join(brandDir, `openagentd-intro-${mode}.gif`),
    ]);
    rmSync(frames, { recursive: true, force: true });
  }
  console.log('wrote the intro as MP4 and GIF (light and dark)');
}

await browser.close();

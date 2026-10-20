// The OpenAgentd logo as SVG markup, built from the outlines in logo-data.ts.
// Source of truth: lthoangg/openagentd web/src/lib/brand/. Used by
// scripts/brand/brand.ts (standalone files) there, and copied as is into
// openagentd.dev (src/lib/, for Logo.astro and the social cards) by its
// `bun run sync-assets`. Keep the only import `./logo-data`: no path aliases.
// Colors and the intro animation live in logo.css (src/styles/ on the site):
// the ink is currentColor and the dot is var(--signal), so the logo follows
// the page's color scheme.
import { LOGO } from './logo-data';

/** The Paper colors, for files that cannot read the page's tokens. */
export const PAPER = {
  light: { bg: '#faf6ec', ink: '#1a1714', signal: '#5aa8e2' },
  dark: { bg: '#15110d', ink: '#f5ebd8', signal: '#7cc2f0' },
} as const;

/** The Seal's scale over the wordmark's A when it stamps down (the intro
 * starts there and shrinks to 1). Keep in step with `oad-seal` in logo.css. */
export const SEAL_START = 1.8;

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function label(title?: string) {
  return title ? ` role="img" aria-label="${esc(title)}"` : ' aria-hidden="true" focusable="false"';
}

/** The Seal mark on its 64-unit grid. */
export function sealSvg({ title, className = '' }: { title?: string; className?: string }): string {
  const { seal } = LOGO;
  return (
    `<svg class="${`oad-logo ${className}`.trim()}" viewBox="0 0 ${seal.grid} ${seal.grid}"${label(title)}>` +
    `<path fill-rule="evenodd" d="${seal.disc}"/>` +
    `<circle class="oad-signal" cx="${seal.dot.cx}" cy="${seal.dot.cy}" r="${seal.dot.r}"/>` +
    `</svg>`
  );
}

interface WordmarkOptions {
  /** Accessible name; omit for a decorative copy (aria-hidden). */
  title?: string;
  className?: string;
  /** Play the intro on load, or when scrolled into view (needs in-view.ts). */
  intro?: 'load' | 'view';
  /** Prefix for the intro's mask ids; unique per page. */
  id?: string;
  /** Grow the viewBox to hold the Seal at its starting size (standalone files). */
  pad?: boolean;
}

/** The wordmark, optionally with the Seal that turns into it. */
export function wordmarkSvg({ title, className = '', intro, id = 'oad', pad = false }: WordmarkOptions): string {
  const { letters, a, dot, seal } = LOGO;
  let [x, y, w, h]: number[] = [...LOGO.viewBox];
  if (pad) {
    const scale = Number(seal.transform.match(/scale\(([\d.]+)\)/)![1]);
    const r = seal.discR * scale * SEAL_START * 1.12;
    const margin = 0.12 * LOGO.em;
    const top = Math.min(y, seal.anchor.y - r) - margin;
    const bottom = Math.max(y + h, seal.anchor.y + r) + margin;
    [x, y, w, h] = [x - margin, top, w + 2 * margin, bottom - top];
  }
  const vb = [x, y, w, h].map((n) => Math.round(n * 10) / 10).join(' ');
  const word =
    `<g class="oad-word">` +
    letters.map((l) => `<path class="oad-l oad-${l.side} oad-d${l.dist}" d="${l.d}"/>`).join('') +
    `</g>` +
    `<path class="oad-a" d="${a}"/>` +
    `<circle class="oad-dot oad-signal" cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}"/>`;
  const box = `x="-8" y="-8" width="80" height="80"`;
  // The iris covers the disc once it has grown by 12% (logo.css).
  const iris = (fill: string) =>
    `<circle class="oad-iris" cx="${seal.grid / 2}" cy="${seal.grid / 2}" r="${Math.round(seal.discR * 1.12 * 1.04 * 10) / 10}" fill="${fill}"/>`;
  const sealGroup = intro
    ? `<g transform="translate(${seal.anchor.x} ${seal.anchor.y})"><g class="oad-seal"><g transform="${seal.transform}">` +
      `<mask id="${id}-hole" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="#fff"/>${iris('#000')}</mask>` +
      `<mask id="${id}-ink" maskUnits="userSpaceOnUse" ${box}>${iris('#fff')}</mask>` +
      `<path class="oad-disc" fill-rule="evenodd" d="${seal.disc}" mask="url(#${id}-hole)"/>` +
      `<path d="${seal.a}" mask="url(#${id}-ink)"/>` +
      `<circle class="oad-seal-dot oad-signal" cx="${seal.dot.cx}" cy="${seal.dot.cy}" r="${seal.dot.r}"/>` +
      `</g></g></g>`
    : '';
  const play = intro ? ` data-intro="${intro}"${intro === 'view' ? ' data-animate' : ''}` : '';
  return `<svg class="${`oad-logo ${className}`.trim()}" viewBox="${vb}"${play}${label(title)}>${word}${sealGroup}</svg>`;
}

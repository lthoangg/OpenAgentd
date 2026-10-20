/**
 * The logo appears outside React in two generated places: the boot loader in
 * `web/index.html` and `web/public/favicon.svg`. Both are written by
 * `scripts/brand/brand.ts`; these checks fail if either drifts from the
 * outlines in `lib/brand/logo-data.ts`, or if a retired asset comes back.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOGO } from '@/lib/brand/logo-data'

const WEB = new URL('../../../', import.meta.url).pathname
const read = (path: string) => readFileSync(join(WEB, path), 'utf8')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx|css|html)$/.test(name) ? [path] : []
  })
}

describe('brand sync', () => {
  it('boot loader carries the generated Seal', () => {
    const html = read('index.html')
    const region = html.slice(html.indexOf('<!-- brand:seal:start -->'), html.indexOf('<!-- brand:seal:end -->'))
    const { dot } = LOGO.seal
    expect(region).toContain(`d="${LOGO.seal.disc}"`)
    expect(region).toContain(`cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}"`)
  })

  it('favicon is the Seal and follows the color scheme', () => {
    const svg = read('public/favicon.svg')
    expect(svg).toContain(`d="${LOGO.seal.disc}"`)
    expect(svg).toContain('prefers-color-scheme:dark')
  })

  it('no retired mascot or app-icon references remain', () => {
    const testsDir = join(WEB, 'src/__tests__')
    const files = [join(WEB, 'index.html'), ...sourceFiles(join(WEB, 'src')).filter((f) => !f.startsWith(testsDir))]
    const hits = files.filter((file) => /octobot|brand-assets|app-icon/i.test(readFileSync(file, 'utf8')))
    expect(hits).toEqual([])
  })
})

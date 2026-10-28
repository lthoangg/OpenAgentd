import { expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAZY_SURFACES, LIMITS, budgetFailures, lazySurfaceFailures, measureBundle } from '../../../scripts/check-bundle-budget.mjs'

it('fails each exceeded startup budget rather than just warning', () => {
  expect(budgetFailures({ eagerBytes: 101, eagerGzipBytes: 21, largestChunkBytes: 51 },
    { eagerBytes: 100, eagerGzipBytes: 20, largestChunkBytes: 50 })).toHaveLength(3)
})

it('accepts values at the budget boundary', () => {
  expect(budgetFailures({ eagerBytes: 100 }, { eagerBytes: 100 })).toEqual([])
})

// A tiny production build: index.html loads index.js, which imports app.js
// and lazily imports Settings.js.
function fakeDist(files) {
  const dir = mkdtempSync(join(tmpdir(), 'oad-budget-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<script type="module" src="/assets/index-a1.js"></script>')
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), source)
  return dir
}

it('lists the chunks the startup path loads', () => {
  const dir = fakeDist({
    'index-a1.js': 'import "./app-b2.js"; const s = () => import("./SettingsModal-c3.js")',
    'app-b2.js': 'export const a = 1',
    'SettingsModal-c3.js': 'export const s = 1',
  })
  expect(measureBundle(dir).eagerChunks.sort()).toEqual(['app-b2.js', 'index-a1.js'])
})

it('fails when a lazy surface is pulled into the startup path', () => {
  const lazy = fakeDist({ 'index-a1.js': 'const s = () => import("./SettingsModal-c3.js")', 'SettingsModal-c3.js': '' })
  expect(lazySurfaceFailures(lazy, ['SettingsModal'])).toEqual([])
  const eager = fakeDist({ 'index-a1.js': 'import "./SettingsModal-c3.js"', 'SettingsModal-c3.js': '' })
  expect(lazySurfaceFailures(eager, ['SettingsModal'])).toEqual(['SettingsModal loads with the startup path; keep it behind lazySurface'])
})

it('fails when a lazy surface has no chunk of its own (bundled into another one)', () => {
  const dir = fakeDist({ 'index-a1.js': 'export const settings = 1' })
  expect(lazySurfaceFailures(dir, ['SettingsModal'])).toEqual(['SettingsModal has no chunk of its own; keep it behind lazySurface'])
})

// The startup path was 2.65 MB / 810 kB gzip before Settings, Telemetry, the
// scheduler and MCP app results moved behind lazySurface. Growing back past
// that is a decision to revisit, not a budget bump.
it('keeps the startup budget below the size before the lazy surfaces', () => {
  expect(LIMITS.eagerGzipBytes).toBeLessThan(810_000)
  expect(LIMITS.eagerBytes).toBeLessThan(2_654_000)
  expect(LAZY_SURFACES).toEqual(expect.arrayContaining(['SettingsModal', 'TelemetryOverlay', 'SchedulerPanel', 'SchedulerDockView', 'MCPAppResult']))
})

import { readFileSync, readdirSync } from 'node:fs'
import { basename, resolve, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'

export function budgetFailures(sizes, limits) {
  return Object.entries(limits).flatMap(([name, limit]) =>
    sizes[name] > limit ? [`${name}: ${sizes[name]} bytes exceeds ${limit}`] : [])
}

export function measureBundle(directory) {
  const assets = resolve(directory, 'assets')
  const parser = new Bun.Transpiler({ loader: 'js' })
  const chunks = new Map(readdirSync(assets).filter((name) => name.endsWith('.js'))
    .map((name) => [resolve(assets, name), readFileSync(resolve(assets, name))]))
  const html = readFileSync(resolve(directory, 'index.html'), 'utf8')
  const pending = [...html.matchAll(/(?:src|href)="\/assets\/([^"?]+\.js)"/g)]
    .map((match) => resolve(assets, match[1]))
  if (!pending.length) throw new Error('No startup JavaScript found in production HTML')
  const eager = new Set()
  while (pending.length) {
    const path = pending.pop()
    if (eager.has(path)) continue
    const source = chunks.get(path)
    if (!source) throw new Error(`Missing production chunk: ${path}`)
    eager.add(path)
    for (const dependency of parser.scanImports(source.toString())) {
      if (dependency.kind === 'import-statement' && dependency.path.startsWith('.')) {
        pending.push(resolve(dirname(path), dependency.path))
      }
    }
  }
  return {
    eagerChunks: [...eager].map((path) => basename(path)),
    eagerBytes: [...eager].reduce((total, path) => total + chunks.get(path).length, 0),
    eagerGzipBytes: [...eager].reduce((total, path) => total + gzipSync(chunks.get(path)).length, 0),
    largestChunkBytes: Math.max(...[...chunks.values()].map((source) => source.length)),
  }
}

// Surfaces kept out of the startup path (`web/src/lib/lazy-surface.tsx`):
// each loads on first use or while the app is idle after it starts. A static
// import from startup code would quietly put it back; this check fails then.
export const LAZY_SURFACES = ['SettingsModal', 'TelemetryOverlay', 'settings.plugins', 'SchedulerPanel', 'SchedulerDockView', 'MCPAppResult']

// The startup path loads everything not behind a dynamic import. History:
// features had grown it from 2.37 MB / 705 kB gzip (early October) to
// 2.654 MB / 810 kB with a 1.98 MB index chunk (v3.34.0), each release
// raising this budget. Moving Settings, Telemetry, the scheduler and MCP app
// results (with the MCP SDK) behind `lazySurface` cut it to 2.021 MB /
// 641 kB with a 1.17 MB index chunk. Limits sit just above that. A new
// surface that is not needed on the first screen belongs behind
// `lazySurface`, not in a raised budget; `bundle-budget.test.js` keeps the
// limits under the pre-split size.
export const LIMITS = { eagerBytes: 2_030_000, eagerGzipBytes: 645_000, largestChunkBytes: 1_180_000 }

/** Each lazy surface must have a chunk of its own, outside the startup path. */
export function lazySurfaceFailures(directory, names = LAZY_SURFACES) {
  const chunks = readdirSync(resolve(directory, 'assets')).filter((name) => name.endsWith('.js'))
  const eager = new Set(measureBundle(directory).eagerChunks)
  return names.flatMap((name) => {
    const own = chunks.filter((chunk) => chunk.startsWith(`${name}-`))
    if (!own.length) return [`${name} has no chunk of its own; keep it behind lazySurface`]
    return own.some((chunk) => eager.has(chunk)) ? [`${name} loads with the startup path; keep it behind lazySurface`] : []
  })
}

if (import.meta.main) {
  const dist = resolve(import.meta.dir, '../dist')
  const { eagerChunks: _chunks, ...sizes } = measureBundle(dist)
  console.log('Production JavaScript budget:', sizes)
  const failures = [...budgetFailures(sizes, LIMITS), ...lazySurfaceFailures(dist)]
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

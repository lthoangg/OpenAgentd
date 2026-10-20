import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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
    eagerBytes: [...eager].reduce((total, path) => total + chunks.get(path).length, 0),
    eagerGzipBytes: [...eager].reduce((total, path) => total + gzipSync(chunks.get(path)).length, 0),
    largestChunkBytes: Math.max(...[...chunks.values()].map((source) => source.length)),
  }
}

if (import.meta.main) {
  const sizes = measureBundle(resolve(import.meta.dir, '../dist'))
  // App surfaces (Settings pages, Telemetry, the review dock, the scheduler
  // and Session Settings modals, Markdown, MCP app results) load with the
  // shell, so opening one never waits on a chunk; that raised the eager graph
  // by ~231 kB gzip. Only the heavy renderers stay lazy: PDF.js, xterm and
  // KaTeX (Mermaid.js was removed; Pele now draws Mermaid fences and loads on first use).
  // Limits sit just above the measured 2.54 MB / 754 kB gzip, and the
  // 1.90 MB index chunk is now the largest one.
  // The plan review (Plan tab, transcript card) raised it to 2.57 MB / 765 kB.
  // The web preview (Preview tab, design comments) raised it to 2.61 MB /
  // 778 kB, with a 1.97 MB index chunk.
  // Design feedback chips, comment editing and React 19 source mapping
  // raised it to 2.62 MB / 783 kB, with a 1.98 MB index chunk.
  // Loading KaTeX and its stylesheet on first use lowered it to
  // 2.37 MB / 705 kB, with a 1.72 MB index chunk.
  // Desktop keyboard focus (zones, row keys, dock tab keys, drag and the
  // launcher, chat menus, tooltip timing) raised it to 2.39 MB / 716 kB,
  // with a 1.75 MB index chunk.
  // Later features (the shared event stream, window titles, UI primitives)
  // and framer-motion 14 raised it to 2.39 MB / 721 kB, with a 1.75 MB
  // index chunk.
  // `/btw` side questions (panel, store, client) added 12 kB / 4 kB gzip:
  // 2.41 MB / 726 kB, with a 1.76 MB index chunk.
  // Sidebar sections (View options, Pinned, the flat Status / Date / None
  // views) and the new-session screen with its folder picker added 40 kB /
  // 12 kB gzip: 2.45 MB / 739 kB, with a 1.80 MB index chunk.
  // framer-motion 14.3 (hardware-accelerated independent transforms) added
  // 9 kB / 3 kB gzip: 2.46 MB / 742 kB, with a 1.80 MB index chunk.
  // Later features had already reached 2.48 MB / 752 kB with a 1.82 MB index
  // chunk. Reviewer-shaped plans (the Appendix, plan links) and the Mermaid
  // block with its SVG sanitizer added 10 kB / 3 kB gzip: 2.49 MB / 755 kB,
  // with a 1.83 MB index chunk. Pele itself stays out of the startup graph.
  const limits = { eagerBytes: 2_500_000, eagerGzipBytes: 760_000, largestChunkBytes: 1_840_000 }
  console.log('Production JavaScript budget:', sizes)
  const failures = budgetFailures(sizes, limits)
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

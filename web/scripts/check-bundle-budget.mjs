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
  const limits = { eagerBytes: 2_000_000, eagerGzipBytes: 590_000, largestChunkBytes: 1_500_000 }
  console.log('Production JavaScript budget:', sizes)
  const failures = budgetFailures(sizes, limits)
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

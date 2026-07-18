import { readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const assetsDir = resolve(import.meta.dir, '../dist/assets')
const chunks = (await readdir(assetsDir)).filter((name) => name.endsWith('.js'))
const edges = new Map()

for (const chunk of chunks) {
  const source = await readFile(resolve(assetsDir, chunk), 'utf8')
  const imports = [...source.matchAll(/(?:import|export)(?:[^"']*?from)?["']\.\/([^"']+\.js)["']/g)]
    .map((match) => basename(match[1]))
    .filter((dependency) => chunks.includes(dependency))
  edges.set(chunk, imports)
}

const visiting = new Set()
const visited = new Set()
const path = []

function findCycle(chunk) {
  if (visiting.has(chunk)) return [...path.slice(path.indexOf(chunk)), chunk]
  if (visited.has(chunk)) return null
  visiting.add(chunk)
  path.push(chunk)
  for (const dependency of edges.get(chunk) ?? []) {
    const cycle = findCycle(dependency)
    if (cycle) return cycle
  }
  path.pop()
  visiting.delete(chunk)
  visited.add(chunk)
  return null
}

for (const chunk of chunks) {
  const cycle = findCycle(chunk)
  if (cycle) {
    console.error(`Circular production chunks: ${cycle.join(' -> ')}`)
    process.exit(1)
  }
}

console.log(`Checked ${chunks.length} production chunks: no circular imports`)

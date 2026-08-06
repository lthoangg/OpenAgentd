/**
 * Empirical check: does `motion.div layout` force a DOM measurement on every
 * parent re-render (the InputBar per-keystroke hypothesis)?
 *
 * Counts real `getBoundingClientRect` calls with the real framer-motion
 * (no test stub) while driving N state updates through a parent, comparing:
 *   A. plain <div>
 *   B. <motion.div> with no layout prop
 *   C. <motion.div layout>
 *   D. <motion.div layout> + animate({ padding })    (the shape InputBar used to have)
 *
 * Run: cd web && bun scripts/bench-motion-layout.mjs
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost:5173/' })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { motion } = await import('framer-motion')

// ── instrument measurement ──────────────────────────────────────────────────
let rectCalls = 0
const originalRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function patched(...args) {
  rectCalls++
  return originalRect.apply(this, args)
}

const KEYSTROKES = 40

/** Drive `KEYSTROKES` parent re-renders and return the measurement count. */
async function run(label, renderPill) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let setValue
  function Harness() {
    const [value, set] = React.useState('')
    setValue = set
    // Mirrors InputBar: `minimized` is stable while typing.
    return renderPill(value, false)
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })

  // Let framer's projection loop settle after mount, then start counting.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50))
  })
  rectCalls = 0

  for (let i = 0; i < KEYSTROKES; i++) {
    await act(async () => {
      setValue('x'.repeat(i + 1))
      // one frame per keystroke, like a real typist
      await new Promise((r) => setTimeout(r, 16))
    })
  }

  const measured = rectCalls
  await act(async () => root.unmount())
  container.remove()
  console.log(
    `${label.padEnd(46)} ${String(measured).padStart(5)} rect calls  ` +
      `(${(measured / KEYSTROKES).toFixed(2)}/keystroke)`,
  )
  return measured
}

console.log(`\nDriving ${KEYSTROKES} parent re-renders per variant\n`)

const a = await run('A. plain <div>', (v) =>
  React.createElement('div', null, v),
)
const b = await run('B. <motion.div> (no layout)', (v) =>
  React.createElement(motion.div, null, v),
)
const c = await run('C. <motion.div layout>', (v) =>
  React.createElement(motion.div, { layout: true }, v),
)
const d = await run('D. <motion.div layout animate={{padding}}>', (v, min) =>
  React.createElement(
    motion.div,
    {
      layout: true,
      initial: false,
      animate: { padding: min ? 6 : 8 },
      transition: { duration: 0.24 },
    },
    v,
  ),
)

console.log('\n── delta vs plain div ──')
console.log(`B (motion, no layout): ${b - a}`)
console.log(`C (motion + layout)  : ${c - a}`)
console.log(`D (layout + padding)  : ${d - a}`)
console.log()

process.exit(0)

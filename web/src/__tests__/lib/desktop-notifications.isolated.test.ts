import { describe, expect, it } from 'bun:test'

const TEST_FILE = new URL('./desktop-notifications.worker.ts', import.meta.url).pathname
const BUN_EXECUTABLE = process.env.BUN_EXECUTABLE ?? 'bun'

type SpawnResult = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

const spawn = (globalThis as unknown as {
  Bun: {
    spawn: (command: string[], options: { cwd: string; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult
  }
}).Bun.spawn

async function runWorker(name: string): Promise<void> {
  const proc = spawn([BUN_EXECUTABLE, 'test', TEST_FILE, '--test-name-pattern', name], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(`${stdout}\n${stderr}`).toContain(' 1 pass')
  expect(exitCode).toBe(0)
}

describe('desktop notification library integration', () => {
  it('sends native notifications when the desktop window is not focused', async () => {
    await runWorker('unfocused native send')
  })

  it('skips focused-window notifications but allows forced tests', async () => {
    await runWorker('focused skip and forced send')
  })

  it('sends native notifications in the mobile app without focused-window skip', async () => {
    await runWorker('mobile native app')
  })

  it('reports unsupported runtime before touching native APIs', async () => {
    await runWorker('unsupported runtime')
  })

  it('requests OS permission once and does not notify when denied', async () => {
    await runWorker('permission denied')
  })
})

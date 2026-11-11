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
  it('sends native notifications without an extra in-app sound', async () => {
    await runWorker('unfocused native send')
  })

  it('skips focused-window notifications but allows forced tests', async () => {
    await runWorker('focused skip and forced send')
  })

  it('sends mobile notifications through the notification plugin without focused-window skip or in-app sound', async () => {
    await runWorker('mobile plugin send')
  })

  it('skips a mobile notification for the session on screen only while the page is visible', async () => {
    await runWorker('mobile on-screen skip')
  })

  it('opens the notified session on its server when an Android notification is tapped', async () => {
    await runWorker('an Android tap opens')
  })

  it('remembers what a mobile notification opens in storage that outlives the page', async () => {
    await runWorker('remembers what a notification opens')
  })

  it('listens to the notification plugin only on Android', async () => {
    await runWorker('listens to the plugin only on Android')
  })

  it('reports unsupported runtime before touching native APIs', async () => {
    await runWorker('unsupported runtime')
  })

  it('requests OS permission once and does not notify when denied', async () => {
    await runWorker('permission denied')
  })

  it('leaves Done and Needs you to the account push while the iPhone app is hidden', async () => {
    await runWorker('leaves Done and Needs you to the push')
  })

  it('skips events handled just after the iPhone app comes back when the push showed them', async () => {
    await runWorker('skips events handled just after the app comes back')
  })

  it('still notifies from the open iPhone app, where iOS hides the push', async () => {
    await runWorker('still notifies from the open app')
  })

  it('keeps local notifications for kinds the computer does not push', async () => {
    await runWorker('keeps kinds the computer does not push')
  })

  it('still notifies from a hidden phone app without account push', async () => {
    await runWorker('a hidden phone app without account push')
  })

  it('relies on the account push only when this iPhone really registered for it', async () => {
    await runWorker('skips its own only when push really reaches this phone')
  })

  it('leaves replayed notifications to the account push on an iPhone that gets it', async () => {
    await runWorker('leaves a replayed Done or question to the push')
  })
})

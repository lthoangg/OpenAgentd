/**
 * Following a server update through its restart: start, wait while the
 * server is away, done once it answers on the target version, failed when
 * the helper says so or the server never comes back.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ServerUpdateStatus } from '@/api/client/server-update'

let startRefusal: Error | null = null
const startServerUpdate = mock(async () => {
  if (startRefusal) throw startRefusal
  return { status: 'started' as const, from: '3.50.0', target: '3.51.0', started_at: 'T0' }
})
const answers: Array<ServerUpdateStatus | Error> = []
const getServerUpdate = mock(async () => {
  const next = answers.shift() ?? new Error('down')
  if (next instanceof Error) throw next
  return next
})
mock.module('@/api/client/server-update', () => ({ startServerUpdate, getServerUpdate }))

const { readProgress, useServerUpdateStore } = await import('@/stores/useServerUpdateStore')

function status(overrides: Partial<ServerUpdateStatus>): ServerUpdateStatus {
  return {
    current: '3.50.0',
    latest: '3.51.0',
    available: true,
    can_upgrade: true,
    method: 'release',
    reason: null,
    check_error: null,
    in_progress: true,
    release_url: null,
    log: '/srv/state/logs/upgrade.log',
    last: { state: 'running', started_at: 'T0' },
    ...overrides,
  }
}

const realSetTimeout = globalThis.setTimeout
beforeEach(() => {
  answers.length = 0
  startRefusal = null
  startServerUpdate.mockClear()
  getServerUpdate.mockClear()
  useServerUpdateStore.setState({ phase: { kind: 'idle' } })
  // Poll without waiting two seconds a round.
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout
})
afterEach(() => {
  globalThis.setTimeout = realSetTimeout
})

const started = { target: '3.51.0', startedAt: 'T0' }

describe('readProgress', () => {
  it('keeps waiting while the old server still answers mid-update', () => {
    expect(readProgress(status({}), started)).toBeNull()
  })

  it('is done once the server answers on the target version', () => {
    expect(readProgress(status({ current: '3.51.0' }), started)).toEqual({ kind: 'done', from: '', to: '3.51.0' })
  })

  it('fails with the helper message and the log when it finished badly', () => {
    const s = status({ in_progress: false, last: { state: 'finished', ok: false, message: 'checksum mismatch', started_at: 'T0' } })
    expect(readProgress(s, started)).toEqual({ kind: 'failed', message: 'checksum mismatch', log: '/srv/state/logs/upgrade.log' })
  })

  it('does not read an older run as this one', () => {
    const older = status({ in_progress: true, last: { state: 'finished', ok: false, message: 'old', started_at: 'T-1' } })
    expect(readProgress(older, started)).toBeNull()
    const gone = status({ in_progress: false, last: { state: 'finished', ok: true, started_at: 'T-1' } })
    expect(readProgress(gone, started)?.kind).toBe('failed')
  })
})

describe('useServerUpdateStore.start', () => {
  it('waits through the restart and ends done on the new version', async () => {
    answers.push(status({}), new Error('connection refused'), new Error('connection refused'), status({ current: '3.51.0' }))
    const settled = mock(() => {})
    const run = useServerUpdateStore.getState().start({ onSettled: settled })
    await Promise.resolve()
    expect(useServerUpdateStore.getState().phase).toEqual({ kind: 'updating', from: '3.50.0', target: '3.51.0' })
    await run
    expect(useServerUpdateStore.getState().phase).toEqual({ kind: 'done', from: '3.50.0', to: '3.51.0' })
    expect(getServerUpdate).toHaveBeenCalledTimes(4)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('says why when the server refuses to start an update', async () => {
    startRefusal = new Error('Already on the latest release (v3.51.0).')
    await useServerUpdateStore.getState().start()
    expect(useServerUpdateStore.getState().phase).toEqual({ kind: 'failed', message: 'Already on the latest release (v3.51.0).' })
    expect(getServerUpdate).not.toHaveBeenCalled()
  })

  it('ignores a second start while one runs', async () => {
    useServerUpdateStore.setState({ phase: { kind: 'updating', from: '3.50.0', target: '3.51.0' } })
    await useServerUpdateStore.getState().start()
    expect(startServerUpdate).not.toHaveBeenCalled()
  })
})

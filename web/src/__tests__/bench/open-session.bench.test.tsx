/**
 * Opening a long session, measured against a running backend. Skipped unless
 * ``OAD_BENCH_URL`` names one (``http://127.0.0.1:4190``).
 *
 * ``OAD_BENCH_SESSIONS`` (ids, comma-separated): per session, the first
 * history page's size, the time ``loadSession`` takes from the request to the
 * committed store (network, JSON parse, block parse), and the time to mount
 * the transcript it produced.
 *
 * ``OAD_BENCH_RUNNING`` (one id of a session with a turn in flight): opens it
 * through the real ``useSessionBootstrap`` and the transcript, and reports the
 * time from open to the first frame showing the history and to the first
 * frame showing the running turn.
 *
 *   OAD_BENCH_URL=http://127.0.0.1:4190 OAD_BENCH_SESSIONS=<id>,<id> \
 *     bun test src/__tests__/bench/open-session.bench.test.tsx
 */
import { describe, expect, it } from 'bun:test'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import { createRef, useLayoutEffect } from 'react'
import { render, cleanup } from '@testing-library/react'

import { AgentView } from '@/components/AgentView'
import { useSessionBootstrap } from '@/components/AgentChatView/useSessionBootstrap'
import type { InputComposerHandle } from '@/components/InputComposer'
import { useAgentStore } from '@/stores/useAgentStore'

const BASE = process.env.OAD_BENCH_URL ?? ''
const SESSIONS = (process.env.OAD_BENCH_SESSIONS ?? '').split(',').filter(Boolean)
const RUNNING = process.env.OAD_BENCH_RUNNING ?? ''
const WORKSPACE = process.env.OAD_BENCH_WORKSPACE ?? '/bench'
const RUNS = Number(process.env.OAD_BENCH_RUNS ?? 3)

let lastBytes = 0

/** A streaming ``fetch`` over node:http: Happy DOM's own one applies browser CORS. */
function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET' }, (res) => {
      const status = res.statusCode ?? 0
      const text = async () => {
        const chunks: Buffer[] = []
        for await (const chunk of res) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks).toString('utf8')
        lastBytes = Buffer.byteLength(body)
        return body
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        get body() { return Readable.toWeb(res) },
        json: async () => JSON.parse(await text()),
        text,
      } as unknown as Response)
    })
    init.signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    req.on('error', reject)
    req.end()
  })
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function useLead() {
  return useAgentStore((s) => (s.leadName ? s.agentStreams[s.leadName] : undefined))
}

// Stable across renders: the bootstrap effect depends on them.
const inputRef = createRef<InputComposerHandle>()
const navigate = (() => {}) as never
const loadAgentStatus = async () => {}

/** The chat's session wiring and transcript; reports the first frames that show history and the live turn. */
function OpenSession({ sessionId, onFrame }: { sessionId: string; onFrame: (kind: 'history' | 'live') => void }) {
  const store = useAgentStore.getState()
  useSessionBootstrap({
    sessionId,
    workspace: WORKSPACE,
    agentWorkspace: WORKSPACE,
    hasWorkspace: true,
    isSessionLoading: false,
    isMobile: true,
    paletteOpen: false,
    sessionTitle: null,
    isAgentWorking: false,
    inputRef,
    navigate,
    connectStream: store.connectStream,
    loadAgentStatus,
    loadSession: store.loadSession,
    catchUpLiveTurn: store.catchUpLiveTurn,
    beginResolvedSession: store.beginResolvedSession,
    consumeResolvedSessionReady: store.consumeResolvedSessionReady,
  })
  const lead = useLead()
  const blocks = lead?.blocks ?? []
  const currentBlocks = lead?.currentBlocks ?? []
  useLayoutEffect(() => {
    if (blocks.length > 0) onFrame('history')
    if (blocks.length > 0 && currentBlocks.length > 0) onFrame('live')
  })
  return <AgentView blocks={blocks} currentBlocks={currentBlocks} isWorking={useAgentStore((s) => s.isAgentWorking)} />
}

describe('open a long session (bench)', () => {
  it('reports bytes, load and mount times', async () => {
    // Measured only against a backend named in the environment.
    if (!BASE || SESSIONS.length === 0) return
    globalThis.fetch = nodeFetch as typeof fetch
    window.__OAD_API_BASE_URL__ = `${BASE}/api`
    const rows: string[] = []
    for (const sessionId of SESSIONS) {
      const load: number[] = []
      const mount: number[] = []
      for (let run = 0; run < RUNS; run++) {
        useAgentStore.getState().newSession()
        useAgentStore.getState().beginResolvedSession(sessionId, { workspace: WORKSPACE })
        const started = performance.now()
        await useAgentStore.getState().loadSession(sessionId, WORKSPACE)
        load.push(performance.now() - started)
        const state = useAgentStore.getState()
        expect(state.error).toBeNull()
        const lead = state.leadName ? state.agentStreams[state.leadName] : undefined
        const mountStarted = performance.now()
        render(<AgentView blocks={lead?.blocks ?? []} currentBlocks={lead?.currentBlocks ?? []} isWorking={false} />)
        mount.push(performance.now() - mountStarted)
        cleanup()
      }
      const members = Object.keys(useAgentStore.getState().agentStreams).length - 1
      rows.push(`${sessionId} bytes=${lastBytes} members=${members} load_ms=${median(load).toFixed(0)} mount_ms=${median(mount).toFixed(0)}`)
    }
    console.log(`\n${rows.join('\n')}`)
  }, 600_000)

  it('reports the first frames of a running session', async () => {
    if (!BASE || !RUNNING) return
    globalThis.fetch = nodeFetch as typeof fetch
    window.__OAD_API_BASE_URL__ = `${BASE}/api`
    const history: number[] = []
    const live: number[] = []
    for (let run = 0; run < RUNS; run++) {
      useAgentStore.getState().newSession()
      const frames: Partial<Record<'history' | 'live', number>> = {}
      let started = 0
      const seen = new Promise<void>((resolve) => {
        const onFrame = (kind: 'history' | 'live') => {
          frames[kind] ??= performance.now() - started
          if (frames.live !== undefined) resolve()
        }
        started = performance.now()
        render(<OpenSession sessionId={RUNNING} onFrame={onFrame} />)
      })
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      await Promise.race([seen, timeout])
      expect(useAgentStore.getState().error).toBeNull()
      expect(frames.live).toBeDefined()
      history.push(frames.history ?? NaN)
      live.push(frames.live ?? NaN)
      cleanup()
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    console.log(`\n${RUNNING} running: history_frame_ms=${median(history).toFixed(0)} live_frame_ms=${median(live).toFixed(0)} runs=[${live.map((v) => v.toFixed(0)).join(' ')}]`)
  }, 600_000)
})

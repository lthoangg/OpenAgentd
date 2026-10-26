/**
 * Palette Switch Server… — the builtin sidecar and saved servers.
 */
import { describe, expect, it, mock } from 'bun:test'
import type { AppBackendStatus } from '@/lib/app-backend'
import {
  buildServerCommands,
  type ServerCommandHandlers,
  type ServerCommandsInput,
} from '@/components/AgentChatView/paletteServerCommands'

const REMOTE = 'http://192.168.1.30:4082'
const LAB = 'http://192.168.1.20:4082'

function status(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: 'http://127.0.0.1:5000',
    mode: 'bundled',
    sidecar_running: true,
    external: false,
    supports_bundled: true,
    servers: [{ base_url: REMOTE, name: 'Work laptop' }, { base_url: LAB }],
    ...overrides,
  }
}

function build(overrides: Partial<ServerCommandsInput> = {}) {
  const handlers: ServerCommandHandlers = {
    useBundled: mock(() => {}),
    useExternal: mock(() => {}),
    manage: mock(() => {}),
    checkHealth: mock(() => {}),
  }
  const commands = buildServerCommands({ status: status(), health: {}, ...overrides }, handlers)
  return { handlers, commands, rows: commands[0]?.page?.commands ?? [] }
}

describe('Switch Server…', () => {
  it('is absent outside the desktop shell', () => {
    expect(build({ status: null }).commands).toEqual([])
  })

  it('has no keyboard shortcut and opens a page of servers', () => {
    const { commands, rows } = build()
    expect(commands).toHaveLength(1)
    expect(commands[0].label).toBe('Switch Server…')
    expect(commands[0].shortcut).toBeUndefined()
    expect(rows.map((r) => r.id)).toEqual(['server:bundled', `server:${REMOTE}`, `server:${LAB}`, 'server:manage'])
  })

  it('marks the builtin as current and connects to a saved server', () => {
    const { rows, handlers } = build({ health: { [REMOTE]: 'online', [LAB]: 'offline' } })
    expect(rows[0].description?.startsWith('Current')).toBe(true)
    expect(rows[1].label).toBe('Work laptop')
    expect(rows[1].description).toBe(`${REMOTE} · Online`)
    expect(rows[2].label).toBe(LAB)
    expect(rows[2].description).toBe('Offline')
    rows[1].action()
    expect(handlers.useExternal).toHaveBeenCalledWith({ base_url: REMOTE, name: 'Work laptop' })
    rows[0].action()
    expect(handlers.useBundled).not.toHaveBeenCalled()
  })

  it('marks the connected remote server as current and offers the builtin', () => {
    const { rows, handlers } = build({
      status: status({ base_url: `${REMOTE}/`, mode: 'external', external: true, sidecar_running: false }),
    })
    expect(rows[0].description).toBe('Stopped · starts when selected')
    expect(rows[1].description?.startsWith('Current · ')).toBe(true)
    rows[1].action()
    expect(handlers.useExternal).not.toHaveBeenCalled()
    rows[0].action()
    expect(handlers.useBundled).toHaveBeenCalledTimes(1)
  })

  it('omits the builtin where the shell has none', () => {
    const { rows } = build({ status: status({ supports_bundled: false }) })
    expect(rows.map((r) => r.id)).not.toContain('server:bundled')
  })

  it('checks the servers when the page opens and links to Settings', () => {
    const { commands, rows, handlers } = build()
    commands[0].onOpenPage?.()
    expect(handlers.checkHealth).toHaveBeenCalledTimes(1)
    const manage = rows[rows.length - 1]
    expect(manage.browseOnly).toBe(true)
    manage.action()
    expect(handlers.manage).toHaveBeenCalledTimes(1)
  })
})

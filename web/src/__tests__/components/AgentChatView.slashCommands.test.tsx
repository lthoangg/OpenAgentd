import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AgentCommandResponse } from '@/api/types'
import { BASE_SLASH_COMMANDS, filterBaseSlashCommands, parseBuiltInSlashCommand } from '@/components/AgentChatView/helpers'
import { useSlashCommands } from '@/components/AgentChatView/useSlashCommands'

const redo = mock(async (): Promise<AgentCommandResponse | undefined> => undefined)
mock.module('@/stores/useAgentStore', () => ({
  useAgentStore: { getState: () => ({ redoAgent: redo, redoAllAgent: redo }) },
}))
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

mock.module('@/queries/useCommandsQuery', () => ({
  useCommandsQuery: () => ({ data: { commands: [] } }),
}))
mock.module('@/queries/useSnippetsQuery', () => ({
  useSnippetsQuery: () => ({ data: { snippets: [] } }),
}))
mock.module('@/api/client', () => ({
  renderCommand: async () => ({ content: '' }),
  renderSnippet: async () => ({ content: '' }),
  resolveApiUrl: () => null,
}))

afterEach(cleanup)

describe('BASE_SLASH_COMMANDS', () => {
  it('includes redo and redo-all with appropriate descriptions', () => {
    const redo = BASE_SLASH_COMMANDS.find((c) => c.id === 'redo')
    const redoAll = BASE_SLASH_COMMANDS.find((c) => c.id === 'redo-all')

    expect(redo).toBeDefined()
    expect(redo?.label).toBe('Redo')
    expect(redo?.description).toBe('Redo the next undone message')

    expect(redoAll).toBeDefined()
    expect(redoAll?.label).toBe('Redo All')
    expect(redoAll?.description).toBe('Restore all undone messages back to the live tip')
  })
})

describe('filterBaseSlashCommands', () => {
  it('shows only /new on an empty idle session', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: false,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['new'])
  })

  it('shows /compact, /undo, /new on a session with messages', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['compact', 'undo', 'new'])
  })

  it('shows /redo and /redo-all when revertedCount > 0', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 2,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual([
      'compact',
      'undo',
      'redo',
      'redo-all',
      'new',
    ])
  })

  it('shows /stop and /new when team is actively working', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: true,
      revertedCount: 2,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['stop', 'new'])
  })

  it('shows /init in coding mode with a workspace attached', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: true,
    })
    expect(commands.map((c) => c.id)).toEqual(['compact', 'undo', 'new', 'init'])
  })

  it('does not show /init in coding mode without a workspace', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['compact', 'undo', 'new'])
  })
})

describe('useSlashCommands', () => {
  const inputRef = {
    current: {
      setValue: mock(() => {}),
      appendValue: mock(() => {}),
      insertText: mock(() => {}),
      setFiles: mock(() => {}),
      addFiles: mock(() => {}),
      focus: mock(() => {}),
      restoreLastSubmission: mock(() => {}),
    },
  }
  const handleNewSession = mock(() => {})

  beforeEach(() => {
    inputRef.current.setValue.mockClear()
    inputRef.current.setFiles.mockClear()
    handleNewSession.mockClear()
    redo.mockImplementation(async () => undefined)
  })

  for (const command of ['redo', 'redo-all'] as const) {
    for (const successful of [false, true]) {
      it(`${command} ${successful ? 'clears the draft on success' : 'preserves the draft after failure or a stale response'}`, async () => {
        redo.mockImplementation(async () => successful
          ? { status: 'accepted', session_id: 'session-1', command }
          : undefined)
        const { result } = renderHook(() => useSlashCommands({
          agentWorkspace: '/tmp/project', inputRef, handleNewSession,
        }))
        await act(async () => { result.current.handleSlashCommand(command) })
        if (successful) {
          expect(inputRef.current.setValue).toHaveBeenCalledWith('')
          expect(inputRef.current.setFiles).toHaveBeenCalledWith([])
        } else {
          expect(inputRef.current.setValue).not.toHaveBeenCalled()
          expect(inputRef.current.setFiles).not.toHaveBeenCalled()
        }
      })
    }
  }

  it('filters slashCommands according to contextual state', () => {
    const { result } = renderHook(() =>
      useSlashCommands({
        agentWorkspace: '/tmp/project',
        inputRef,
        handleNewSession,
        isAgentWorking: false,
        revertedCount: 1,
        hasVisibleMessages: true,
      }),
    )

    const ids = result.current.slashCommands.map((c) => c.id)
    expect(ids).toEqual(['compact', 'undo', 'redo', 'redo-all', 'new', 'init'])
  })

})

describe('parseBuiltInSlashCommand', () => {
  it('extracts known built-in slash commands', () => {
    expect(parseBuiltInSlashCommand('/undo')).toBe('undo')
    expect(parseBuiltInSlashCommand('/redo')).toBe('redo')
    expect(parseBuiltInSlashCommand('/redo-all')).toBe('redo-all')
    expect(parseBuiltInSlashCommand('/redo_all')).toBe('redo-all')
    expect(parseBuiltInSlashCommand('  /compact  ')).toBe('compact')
    expect(parseBuiltInSlashCommand('/stop')).toBe('stop')
    expect(parseBuiltInSlashCommand('/new')).toBe('new')
  })

  it('returns null for non-command or custom command text', () => {
    expect(parseBuiltInSlashCommand('hello world')).toBeNull()
    expect(parseBuiltInSlashCommand('/custom-command')).toBeNull()
    expect(parseBuiltInSlashCommand('')).toBeNull()
  })
})

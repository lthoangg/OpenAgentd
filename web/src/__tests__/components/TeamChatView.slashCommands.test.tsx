import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { BASE_SLASH_COMMANDS, filterBaseSlashCommands, parseBuiltInSlashCommand } from '@/components/TeamChatView/helpers'
import { useSlashCommands } from '@/components/TeamChatView/useSlashCommands'
import { useTeamStore } from '@/stores/useTeamStore'

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
  it('shows only /new on an empty idle normal session', () => {
    const commands = filterBaseSlashCommands({
      isTeamWorking: false,
      revertedCount: 0,
      hasVisibleMessages: false,
      mode: 'normal',
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['new'])
  })

  it('shows /compact, /undo, /new on a normal session with messages', () => {
    const commands = filterBaseSlashCommands({
      isTeamWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      mode: 'normal',
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['compact', 'undo', 'new'])
  })

  it('shows /redo and /redo-all when revertedCount > 0', () => {
    const commands = filterBaseSlashCommands({
      isTeamWorking: false,
      revertedCount: 2,
      hasVisibleMessages: true,
      mode: 'normal',
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
      isTeamWorking: true,
      revertedCount: 2,
      hasVisibleMessages: true,
      mode: 'normal',
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['stop', 'new'])
  })

  it('shows /init in coding mode with a workspace attached', () => {
    const commands = filterBaseSlashCommands({
      isTeamWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      mode: 'coding',
      hasWorkspace: true,
    })
    expect(commands.map((c) => c.id)).toEqual(['compact', 'undo', 'new', 'init'])
  })

  it('does not show /init in coding mode without a workspace', () => {
    const commands = filterBaseSlashCommands({
      isTeamWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      mode: 'coding',
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
  })

  it('filters slashCommands according to contextual state', () => {
    const { result } = renderHook(() =>
      useSlashCommands({
        mode: 'coding',
        agentWorkspace: '/tmp/project',
        inputRef,
        handleNewSession,
        isTeamWorking: false,
        revertedCount: 1,
        hasVisibleMessages: true,
      }),
    )

    const ids = result.current.slashCommands.map((c) => c.id)
    expect(ids).toEqual(['compact', 'undo', 'redo', 'redo-all', 'new', 'init'])
  })

  it('dispatches redo to redoTeam and clears input', async () => {
    const redoTeamMock = mock(async () => undefined)
    useTeamStore.setState({ redoTeam: redoTeamMock })

    const { result } = renderHook(() =>
      useSlashCommands({
        mode: 'normal',
        agentWorkspace: null,
        inputRef,
        handleNewSession,
      }),
    )

    result.current.handleSlashCommand('redo')
    await Promise.resolve()

    expect(redoTeamMock).toHaveBeenCalledTimes(1)
    expect(inputRef.current.setValue).toHaveBeenCalledWith('')
    expect(inputRef.current.setFiles).toHaveBeenCalledWith([])
  })

  it('dispatches redo-all to redoAllTeam and clears input', async () => {
    const redoAllTeamMock = mock(async () => undefined)
    useTeamStore.setState({ redoAllTeam: redoAllTeamMock })

    const { result } = renderHook(() =>
      useSlashCommands({
        mode: 'normal',
        agentWorkspace: null,
        inputRef,
        handleNewSession,
      }),
    )

    result.current.handleSlashCommand('redo-all')
    await Promise.resolve()

    expect(redoAllTeamMock).toHaveBeenCalledTimes(1)
    expect(inputRef.current.setValue).toHaveBeenCalledWith('')
    expect(inputRef.current.setFiles).toHaveBeenCalledWith([])
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

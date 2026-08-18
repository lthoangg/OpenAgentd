import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { BASE_SLASH_COMMANDS } from '@/components/TeamChatView/helpers'
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

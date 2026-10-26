import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AgentCommandResponse } from '@/api/types'
import { BASE_SLASH_COMMANDS, btwSubmit, filterBaseSlashCommands, parseBtwCommand, parseBuiltInSlashCommand } from '@/components/AgentChatView/helpers'
import { useSlashCommands } from '@/components/AgentChatView/useSlashCommands'
import { useBtwStore } from '@/stores/useBtwStore'
import { useHeldMessagesStore } from '@/stores/useHeldMessagesStore'

const redo = mock(async (): Promise<AgentCommandResponse | undefined> => undefined)
const undo = mock(async (): Promise<AgentCommandResponse | undefined> => undefined)
const stopAgent = mock(async () => {})
mock.module('@/stores/useAgentStore', () => ({
  useAgentStore: { getState: () => ({ undoAgent: undo, redoAgent: redo, redoAllAgent: redo, sessionId: 'session-1', stopAgent, _pendingMessages: [] }) },
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
  askSideQuestion: async () => {},
  clearSideQuestions: async () => {},
  stopSideQuestion: async () => true,
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

  it('does not offer /goal: a goal starts from a plan review, not a command', () => {
    expect(BASE_SLASH_COMMANDS.map((c) => c.id)).not.toContain('goal')
    expect(parseBuiltInSlashCommand('/goal')).toBeNull()
    const everything = filterBaseSlashCommands({ isAgentWorking: true, revertedCount: 1, hasVisibleMessages: true, hasLiveMessages: true, hasWorkspace: true })
    expect(everything.map((c) => c.id)).not.toContain('goal')
  })

  it('inserts /btw for a question instead of running it', () => {
    const btw = BASE_SLASH_COMMANDS.find((c) => c.id === 'btw')
    expect(btw).toMatchObject({ keepInputOpen: true, insertText: 'btw' })
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

  it('shows /btw, /compact, /undo, /new on a session with messages', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['btw', 'compact', 'undo', 'new'])
  })

  it('shows /redo and /redo-all when revertedCount > 0', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 2,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual([
      'btw',
      'compact',
      'undo',
      'redo',
      'redo-all',
      'new',
    ])
  })

  it('shows /stop, /btw and /new when team is actively working', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: true,
      revertedCount: 2,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['stop', 'btw', 'new'])
  })

  it('shows /btw during a new session’s first turn, before any block is finalized', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: true,
      hasVisibleMessages: false,
      hasLiveMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['stop', 'btw', 'new'])
  })

  it('shows /init in coding mode with a workspace attached', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: true,
    })
    expect(commands.map((c) => c.id)).toEqual(['btw', 'compact', 'undo', 'new', 'init'])
  })

  it('does not show /init in coding mode without a workspace', () => {
    const commands = filterBaseSlashCommands({
      isAgentWorking: false,
      revertedCount: 0,
      hasVisibleMessages: true,
      hasWorkspace: false,
    })
    expect(commands.map((c) => c.id)).toEqual(['btw', 'compact', 'undo', 'new'])
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
      addDesignFeedback: mock(() => {}),
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
    expect(ids).toEqual(['btw', 'compact', 'undo', 'redo', 'redo-all', 'new', 'init'])
  })

  const undone = (content: string, extra: Record<string, unknown> | null): AgentCommandResponse => ({
    status: 'accepted', session_id: 'session-1', command: 'undo',
    message: {
      id: 'm1', session_id: 'session-1', role: 'user', content, reasoning_content: null, tool_calls: null,
      tool_call_id: null, name: null, is_summary: false, is_hidden: false, extra, created_at: null, attachments: null,
    },
  })

  it('/undo gives the undone prompt back as it was written', async () => {
    undo.mockImplementation(async () => undone('tests pass', null))
    const { result } = renderHook(() => useSlashCommands({ agentWorkspace: '/tmp/project', inputRef, handleNewSession }))
    await act(async () => { result.current.handleSlashCommand('undo') })
    expect(inputRef.current.setValue).toHaveBeenCalledWith('tests pass')
  })

  it('/undo of a goal turn leaves the composer alone: its text is a hidden reminder', async () => {
    undo.mockImplementation(async () => undone('<goal_reminder turn="2">', { goal_turn: { turn: 2, max_turns: 50 } }))
    const { result } = renderHook(() => useSlashCommands({ agentWorkspace: '/tmp/project', inputRef, handleNewSession }))
    await act(async () => { result.current.handleSlashCommand('undo') })
    expect(inputRef.current.setValue).not.toHaveBeenCalled()
    expect(inputRef.current.setFiles).not.toHaveBeenCalled()
  })

  it('a bare /btw reopens the session side questions', async () => {
    useBtwStore.setState({ sessions: {} })
    const { result } = renderHook(() => useSlashCommands({ agentWorkspace: '/tmp/project', inputRef, handleNewSession }))
    await act(async () => { result.current.handleSlashCommand('btw') })
    expect(useBtwStore.getState().sessions['session-1']?.open).toBe(true)
  })

  it('a bare /btw shows side questions through onOpenSideQuestions when given', async () => {
    useBtwStore.setState({ sessions: {} })
    const onOpenSideQuestions = mock((..._args: unknown[]) => {})
    const { result } = renderHook(() => useSlashCommands({ agentWorkspace: '/tmp/project', inputRef, handleNewSession, onOpenSideQuestions }))
    await act(async () => { result.current.handleSlashCommand('btw') })
    expect(onOpenSideQuestions).toHaveBeenCalledWith('session-1')
    expect(useBtwStore.getState().sessions['session-1']).toBeUndefined()
  })

  it('/stop hands messages held for the turn back to the composer', async () => {
    useHeldMessagesStore.setState({ messages: [] })
    useHeldMessagesStore.getState().hold({ sessionId: 'session-1', content: 'after that, run the tests' })
    const { result } = renderHook(() => useSlashCommands({
      agentWorkspace: '/tmp/project', inputRef, handleNewSession, isAgentWorking: true,
    }))

    await act(async () => { result.current.handleSlashCommand('stop') })

    expect(inputRef.current.appendValue).toHaveBeenCalledWith('after that, run the tests', { paragraph: true })
    expect(stopAgent).toHaveBeenCalledTimes(1)
    expect(useHeldMessagesStore.getState().messages).toEqual([])
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

describe('parseBtwCommand', () => {
  it('returns the question, or an empty one for a bare /btw', () => {
    expect(parseBtwCommand('/btw')).toBe('')
    expect(parseBtwCommand('  /btw   ')).toBe('')
    expect(parseBtwCommand('/btw which file?')).toBe('which file?')
    expect(parseBtwCommand('/BTW Which file?')).toBe('Which file?')
    expect(parseBtwCommand('/btw first line\nsecond line')).toBe('first line\nsecond line')
  })

  it('ignores other text and look-alike commands', () => {
    expect(parseBtwCommand('/btwx q')).toBeNull()
    expect(parseBtwCommand('btw q')).toBeNull()
    expect(parseBtwCommand('please /btw q')).toBeNull()
  })
})

describe('btwSubmit', () => {
  const file = new File(['x'], 'a.txt')
  it('asks, reopens, or refuses', () => {
    expect(btwSubmit('hello', undefined, 's')).toEqual({ kind: 'not-btw' })
    expect(btwSubmit('/btw why?', undefined, 's')).toEqual({ kind: 'ask', question: 'why?' })
    expect(btwSubmit('/btw', [], 's')).toEqual({ kind: 'reopen' })
    expect(btwSubmit('/btw why?', [file], 's')).toEqual({ kind: 'attachments' })
    expect(btwSubmit('/btw why?', undefined, null)).toEqual({ kind: 'no-session' })
  })
})

import { beforeEach, describe, expect, it, mock } from 'bun:test'

type RunBody = { model?: string | null; thinking_level?: string | null; credential_id?: string | null }
const saveRunSettings = async (...args: unknown[]) => {
  const body = args[1] as RunBody
  return { id: 'session-1', model: body.model ?? 'agy:claude', thinking_level: body.thinking_level ?? null, credential_id: body.credential_id ?? null }
}
const updateSessionRunSettings = mock(saveRunSettings)
const postAgentChat = mock(async () => ({ status: 'accepted', session_id: 'session-new' }))

mock.module('@/api/client', () => ({
  cancelQueuedMessage: mock(async () => {}),
  postAgentChat,
  postAgentCommand: mock(async () => { throw new Error('not used') }),
  updateSessionInteractionMode: mock(async () => { throw new Error('not used') }),
  updateSessionRunSettings,
  sessionHistory: mock(async () => { throw new Error('not used') }),
  sessionHistorySince: mock(async () => { throw new Error('not used') }),
  agentStatus: mock(async () => { throw new Error('not used') }),
  agentStream: mock(() => {}),
}))

const { useAgentStore } = await import('@/stores/useAgentStore')
const { useToastStore } = await import('@/stores/useToastStore')

beforeEach(() => {
  updateSessionRunSettings.mockClear()
  postAgentChat.mockClear()
  useToastStore.setState({ toasts: [] })
  useAgentStore.setState({
    agentStreams: {},
    leadName: null,
    agentNames: [],
    sessionId: 'session-1',
    sessionModel: 'agy:claude',
    sessionThinkingLevel: null,
    sessionCredentialId: null,
    isAgentWorking: false,
    error: null,
    _pendingMessages: [],
    _abortController: null,
    _reconnectTimer: null,
  })
})

describe('setSessionRunSettings', () => {
  it('shows the choice at once and saves it on the session', async () => {
    const saving = useAgentStore.getState().setSessionRunSettings({ credentialId: 'cred-work' })
    expect(useAgentStore.getState().sessionCredentialId).toBe('cred-work')
    expect(await saving).toBe(true)
    expect(updateSessionRunSettings).toHaveBeenCalledWith('session-1', { credential_id: 'cred-work' })
  })

  it('sends only the fields that changed, with null to clear', async () => {
    useAgentStore.setState({ sessionThinkingLevel: 'high', sessionCredentialId: 'cred-work' })
    await useAgentStore.getState().setSessionRunSettings({ thinkingLevel: null, credentialId: null })
    expect(updateSessionRunSettings).toHaveBeenCalledWith('session-1', { thinking_level: null, credential_id: null })
    expect(useAgentStore.getState().sessionThinkingLevel).toBeNull()
  })

  it('puts the previous choice back when the server refuses, with a Retry that sends it again', async () => {
    updateSessionRunSettings.mockImplementation(async () => { throw new Error('That account or key is turned off') })
    expect(await useAgentStore.getState().setSessionRunSettings({ credentialId: 'cred-off' })).toBe(false)
    updateSessionRunSettings.mockImplementation(saveRunSettings)
    expect(useAgentStore.getState().sessionCredentialId).toBeNull()
    const [toast] = useToastStore.getState().toasts
    expect(toast).toMatchObject({ tone: 'error', title: "Couldn't save the run settings", description: 'That account or key is turned off' })
    expect(toast.action?.label).toBe('Retry')

    toast.action?.onAction()
    await Promise.resolve()
    expect(updateSessionRunSettings).toHaveBeenLastCalledWith('session-1', { credential_id: 'cred-off' })
    expect(useAgentStore.getState().sessionCredentialId).toBe('cred-off')
  })

  it('keeps a new-session draft local and sends the account with the first message', async () => {
    useAgentStore.setState({ sessionId: null })
    expect(await useAgentStore.getState().setSessionRunSettings({ credentialId: 'cred-work' })).toBe(true)
    expect(updateSessionRunSettings).not.toHaveBeenCalled()

    await useAgentStore.getState().sendMessage('hi', undefined, { workspace: '/repo' })
    const args = postAgentChat.mock.calls.at(-1) as unknown as unknown[]
    // ``credentialId``, the 12th argument of ``postAgentChat``.
    expect(args[11]).toBe('cred-work')
  })
})

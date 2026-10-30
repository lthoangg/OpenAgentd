/**
 * A call that changes OpenAgentd's setup (``mcp`` save/remove, ``workspace``
 * set_groups) does not apply itself: the server opens a ``confirm_change``
 * question on its tool call and waits. Its card must be the question card,
 * with **Apply** and **Cancel**, or the user has nothing to press and the
 * row shows the server's "waiting for the user" placeholder as a result.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const answerQuestion = mock(async () => ({ status: 'ok', resumed: true }))
const dismissQuestion = mock(async () => ({ status: 'ok', resumed: false }))
const agentStream = mock(() => {})
mock.module('@/api/client', () => ({ answerQuestion, dismissQuestion, agentStream }))

import { ToolCall } from '@/components/ToolCall'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { useAgentStore } from '@/stores/useAgentStore'
import type { PendingQuestion } from '@/api/types'

const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'
const SAVE_ARGS = JSON.stringify({ action: 'save', server: 'excalidraw', config: { transport: 'http', url: 'https://mcp.excalidraw.com', enabled: true } })

const CONFIRM: PendingQuestion = {
  id: 'q-confirm',
  sessionId: 's-1',
  toolCallId: 'call-save',
  questions: [
    {
      question: 'Update MCP server **excalidraw**: connects to `https://mcp.excalidraw.com`.',
      header: 'Confirm change',
      multiple: false,
      options: [
        { label: 'Apply', description: 'Save it to mcp.json and start it.', recommended: false },
        { label: 'Cancel', description: 'Change nothing.', recommended: false },
      ],
    },
  ],
}

beforeEach(() => {
  answerQuestion.mockClear()
  clearQuestionDrafts()
  useAgentStore.setState({ sessionId: 's-1', isConnected: true, pendingQuestion: CONFIRM, resolvedQuestions: {} })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ pendingQuestion: null, resolvedQuestions: {} })
})

describe('confirming tool calls', () => {
  it('shows Apply and Cancel for an mcp save waiting on the user, not the placeholder', async () => {
    render(<ToolCall name="mcp" args={SAVE_ARGS} result={PLACEHOLDER} done toolCallId="call-save" />)

    expect(screen.getByText('Needs your input')).toBeInTheDocument()
    expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Apply/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }))
    await waitFor(() => expect(answerQuestion).toHaveBeenCalled())
    expect(answerQuestion.mock.calls[0]).toEqual(expect.arrayContaining(['s-1', 'q-confirm']))
  })

  it('shows the card for workspace set_groups and mcp remove too', () => {
    useAgentStore.setState({ pendingQuestion: { ...CONFIRM, toolCallId: 'call-groups' } })
    render(<ToolCall name="workspace" args='{"action":"set_groups","workspace":"api","join":["x"]}' result={PLACEHOLDER} done toolCallId="call-groups" />)
    expect(screen.getByRole('radio', { name: /Apply/ })).toBeInTheDocument()
    cleanup()

    useAgentStore.setState({ pendingQuestion: { ...CONFIRM, toolCallId: 'call-remove' } })
    render(<ToolCall name="mcp" args='{"action":"remove","server":"x"}' result={PLACEHOLDER} done toolCallId="call-remove" />)
    expect(screen.getByRole('radio', { name: /Apply/ })).toBeInTheDocument()
  })

  it('keeps the ordinary row once the call settled, or when it never opened a card', () => {
    useAgentStore.setState({ pendingQuestion: null })
    render(<ToolCall name="mcp" args={SAVE_ARGS} result="The user applied the change. Server 'excalidraw' is ready." done toolCallId="call-save" />)
    expect(screen.queryByText('Needs your input')).not.toBeInTheDocument()
    expect(screen.queryByText('Your input')).not.toBeInTheDocument()
    cleanup()

    render(<ToolCall name="mcp" args={SAVE_ARGS} result="Error: Changes are unavailable in Plan mode." done toolCallId="call-other" />)
    expect(screen.queryByText('Needs your input')).not.toBeInTheDocument()
  })

  it('leaves read-only mcp actions as ordinary rows', () => {
    useAgentStore.setState({ pendingQuestion: { ...CONFIRM, toolCallId: 'call-list' } })
    render(<ToolCall name="mcp" args='{"action":"servers"}' result={PLACEHOLDER} done toolCallId="call-list" />)
    expect(screen.queryByRole('radio', { name: /Apply/ })).not.toBeInTheDocument()
  })
})

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCall } from '@/components/ToolCall'
import { getToolDisplay } from '@/components/ToolCall/display'
import { OPEN_SESSION_EVENT, parseSendResult } from '@/utils/workspace-messages'

afterEach(cleanup)

const SID = '01a11bcb-58e1-77ba-a076-dd7c31403bee'
const ARGS = JSON.stringify({ workspace: 'infra', message: 'Add a queue', reply: true })

describe('send_to_workspace display', () => {
  it('names the target and shows the message', () => {
    const display = getToolDisplay('send_to_workspace', JSON.stringify({ workspace: 'infra', message: 'Add a queue', reply: true }))
    expect(display.headerTitle).toBe('Message to infra (awaiting reply)')
    expect(display.formattedArgs).toBe('Add a queue')
  })

  it('shortens a path target to its folder name', () => {
    const display = getToolDisplay('send_to_workspace', JSON.stringify({ workspace: '/Users/me/src/infra', message: 'x' }))
    expect(display.headerTitle).toBe('Message to infra')
  })

  it('describes list calls', () => {
    expect(getToolDisplay('send_to_workspace', JSON.stringify({ action: 'list' })).headerTitle).toBe('Listing workspaces…')
    expect(getToolDisplay('send_to_workspace', JSON.stringify({ action: 'list', workspace: 'infra' })).headerTitle).toBe('Listing sessions in infra')
  })
})

describe('send_to_workspace result', () => {
  it('reads the session every delivery reached', () => {
    const expected = { workspaceName: 'infra', workspace: '/r/my (infra)', sessionId: SID }
    expect(parseSendResult(`Sent to 'infra' (/r/my (infra)) — new session ${SID} started. Its final answer will arrive here as a message; do not poll.`)).toEqual(expected)
    expect(parseSendResult(`Sent to 'infra' (/r/my (infra)) — delivered to session ${SID}.`)).toEqual(expected)
    expect(parseSendResult(`Sent to 'infra' (/r/my (infra)) — queued in busy session ${SID}; it runs when the current turn ends.`)).toEqual(expected)
    expect(parseSendResult("Error: No registered workspace is named 'infra'.")).toBeNull()
    expect(parseSendResult(undefined)).toBeNull()
  })

  it('offers a switch to the target session once the send succeeded', () => {
    const requests: unknown[] = []
    const listener = (e: Event) => requests.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_SESSION_EVENT, listener)
    try {
      render(<ToolCall name="send_to_workspace" args={ARGS} done result={`Sent to 'infra' (/r/infra) — new session ${SID} started.`} />)
      fireEvent.click(screen.getByRole('button', { name: 'Open in infra' }))
      expect(requests).toEqual([{ sessionId: SID, workspace: '/r/infra' }])
    } finally {
      window.removeEventListener(OPEN_SESSION_EVENT, listener)
    }
  })

  it('offers nothing while running or after a failed send', () => {
    render(<ToolCall name="send_to_workspace" args={ARGS} />)
    expect(screen.queryByRole('button', { name: /^Open in/ })).toBeNull()
    cleanup()
    render(<ToolCall name="send_to_workspace" args={ARGS} done result="Error: Refused: this request has already passed through 3 workspaces." />)
    expect(screen.queryByRole('button', { name: /^Open in/ })).toBeNull()
  })
})

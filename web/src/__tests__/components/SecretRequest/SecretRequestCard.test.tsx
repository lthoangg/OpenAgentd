/**
 * The secret card: values go to the secret store (`saveSecret`) and nowhere
 * else; the answer names keys and choices only; nothing is cached locally.
 * Scenario ids (A1, B3, D2…) refer to the plan's scenarios.md.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const saveSecret = mock(async (...args: unknown[]) => ({ name: String(args[0]), id: 'sec_new' }))
const answerSecretRequest = mock(async () => ({ status: 'ok', resumed: true }))
const answerQuestion = mock(async () => ({ status: 'ok', resumed: true }))
const agentStream = mock(() => {})
mock.module('@/api/client', () => ({ saveSecret, answerSecretRequest, answerQuestion, agentStream }))
mock.module('@/stores/useToastStore', () => ({ useToastStore: { getState: () => ({ push: () => {} }) } }))

import { AskUser } from '@/components/AskUser'
import { useAgentStore } from '@/stores/useAgentStore'
import { toPendingQuestion } from '@/stores/useAgentStore/sse-questions'
import { secretSummaryFromResult } from '@/components/SecretRequest/summary'
import type { PendingQuestion, SecretRequestCard } from '@/api/question-types'
import { questionCardOf, openQuestion } from '@/stores/useAgentStore/question-state'
import { linkOf } from '@/stores/useAgentStore/link-state'

const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'

const CARD: SecretRequestCard = {
  project: '/w/client-b',
  project_name: 'client-b',
  reason: 'Checkout stores receipts in S3 and charges through Stripe.',
  replace: false,
  keys: [
    { name: 'AWS_ACCESS_KEY_ID', help_url: 'https://console.aws.amazon.com/iam', optional: false, multiline: false, state: 'new', values: [] },
    { name: 'STRIPE_SECRET_KEY', help_url: null, optional: false, multiline: false, state: 'elsewhere', values: [{ id: 'sec_a', all: false, projects: [{ key: '/w/client-a', name: 'client-a' }] }] },
    { name: 'GITHUB_TOKEN', help_url: null, optional: false, multiline: false, state: 'available', values: [] },
  ],
}

function question(card: SecretRequestCard = CARD): PendingQuestion {
  return { id: 'q-s', sessionId: 's-1', toolCallId: 'call-s', questions: [{ question: 'The agent needs …', header: 'Secrets', options: [], multiple: false }], kind: 'secret_request', secret: card }
}

beforeEach(() => {
  saveSecret.mockClear()
  answerSecretRequest.mockClear()
  localStorage.clear()
  sessionStorage.clear()
  useAgentStore.setState({ sessionId: 's-1', streamLink: linkOf(true), questionCard: questionCardOf(question()), resolvedQuestions: {} })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ questionCard: questionCardOf(null), resolvedQuestions: {} })
})

/** Every key and value a Storage holds. */
function storedText(store: Storage): string {
  return Array.from({ length: store.length }, (_, i) => { const k = store.key(i) ?? ''; return `${k}=${store.getItem(k)}` }).join('\n')
}

const field = (name: string) => screen.getByLabelText(`${name} value`) as HTMLInputElement

describe('SecretRequestCard', () => {
  it('shows a masked field per key the project lacks, and none for a key it has', () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    expect(field('AWS_ACCESS_KEY_ID').type).toBe('password')
    expect(field('AWS_ACCESS_KEY_ID').autocomplete).toBe('off')
    expect(screen.queryByText('GITHUB_TOKEN')).toBeNull()
    expect(screen.getByText('Needs you · secrets')).toBeInTheDocument()
  })

  it('b3 picks neither option for a value saved for another project', () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    const reuse = screen.getByRole('radio', { name: /Use the one saved for client-a/ }) as HTMLInputElement
    const different = screen.getByRole('radio', { name: /Enter a different value/ }) as HTMLInputElement
    expect(reuse.checked || different.checked).toBe(false)
    fireEvent.change(field('AWS_ACCESS_KEY_ID'), { target: { value: 'AKIAEXAMPLE000001' } })
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('b3 saves a different value for this project, then answers with names only', async () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    fireEvent.change(field('AWS_ACCESS_KEY_ID'), { target: { value: ' AKIAEXAMPLE000001\n' } })
    fireEvent.click(screen.getByRole('radio', { name: /Enter a different value/ }))
    fireEvent.change(field('STRIPE_SECRET_KEY'), { target: { value: 'sk_test_client_b_0002' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save 2' }))

    await waitFor(() => expect(answerSecretRequest).toHaveBeenCalledTimes(1))
    expect(saveSecret.mock.calls).toEqual([
      ['AWS_ACCESS_KEY_ID', { value: 'AKIAEXAMPLE000001', projects: ['/w/client-b'], source: 'chat' }],
      ['STRIPE_SECRET_KEY', { value: 'sk_test_client_b_0002', projects: ['/w/client-b'], source: 'chat' }],
    ])
    const answer = JSON.stringify(answerSecretRequest.mock.calls[0])
    expect(answer).toContain('"action":"provided"')
    for (const v of ['AKIAEXAMPLE000001', 'sk_test_client_b_0002']) {
      expect(answer).not.toContain(v)
      expect(JSON.stringify(useAgentStore.getState())).not.toContain(v)
      expect(storedText(localStorage)).not.toContain(v)
      expect(storedText(sessionStorage)).not.toContain(v)
    }
    await waitFor(() => expect(openQuestion(useAgentStore.getState())).toBeNull())
    expect(useAgentStore.getState().resolvedQuestions['call-s']?.answers).toEqual([['Provided: AWS_ACCESS_KEY_ID, STRIPE_SECRET_KEY']])
  })

  it('b2 reuses a saved value without sending one, for all projects when chosen', async () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    fireEvent.change(field('AWS_ACCESS_KEY_ID'), { target: { value: 'AKIAEXAMPLE000001' } })
    fireEvent.click(screen.getByRole('radio', { name: /Use the one saved for client-a/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'All projects' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save 2' }))
    await waitFor(() => expect(answerSecretRequest).toHaveBeenCalledTimes(1))
    expect(saveSecret.mock.calls).toEqual([['AWS_ACCESS_KEY_ID', { value: 'AKIAEXAMPLE000001', projects: ['*'], source: 'chat' }]])
    expect(answerSecretRequest.mock.calls[0]).toEqual(['s-1', 'q-s', { keys: [{ name: 'AWS_ACCESS_KEY_ID', action: 'provided' }, { name: 'STRIPE_SECRET_KEY', action: 'reuse', id: 'sec_a' }] }])
  })

  it('d2 replaces a shared value only in this project when asked to', async () => {
    const replace: SecretRequestCard = {
      ...CARD,
      replace: true,
      keys: [{ name: 'OPENWEATHER_API_KEY', help_url: null, optional: false, multiline: false, state: 'replace', values: [{ id: 'sec_w', all: false, projects: [{ key: '/w/weather', name: 'weather' }, { key: '/w/dash', name: 'dash' }] }] }],
    }
    useAgentStore.setState({ questionCard: questionCardOf(question(replace)) })
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    expect((screen.getByRole('radio', { name: /Replace it everywhere/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(field('OPENWEATHER_API_KEY'), { target: { value: 'owm_new_value_0002' } })
    fireEvent.click(screen.getByRole('radio', { name: /only in this project/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(answerSecretRequest).toHaveBeenCalledTimes(1))
    expect(saveSecret.mock.calls).toEqual([['OPENWEATHER_API_KEY', { value: 'owm_new_value_0002', projects: ['/w/client-b'], source: 'chat' }]])
  })

  it('a8 declines without sending any value', async () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    fireEvent.change(field('AWS_ACCESS_KEY_ID'), { target: { value: 'AKIAEXAMPLE000001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(answerSecretRequest).toHaveBeenCalledTimes(1))
    expect(saveSecret).not.toHaveBeenCalled()
    expect(answerSecretRequest.mock.calls[0]).toEqual(['s-1', 'q-s', { declined: true }])
  })

  it('a6 warns about a value too short to hide', () => {
    render(<AskUser toolCallId="call-s" result={PLACEHOLDER} secret />)
    fireEvent.change(field('AWS_ACCESS_KEY_ID'), { target: { value: 'abc' } })
    expect(screen.getByText(/can't be hidden/)).toBeInTheDocument()
  })

  it('shows a names-only summary from the persisted result after a reload', () => {
    useAgentStore.setState({ questionCard: questionCardOf(null) })
    render(<AskUser toolCallId="call-s" result="The user provided AWS_ACCESS_KEY_ID. They chose saved values for STRIPE_SECRET_KEY. Use them in commands …" secret />)
    expect(screen.getByText('Provided: AWS_ACCESS_KEY_ID')).toBeInTheDocument()
    expect(screen.getByText('Using saved: STRIPE_SECRET_KEY')).toBeInTheDocument()
  })
})

describe('secret card wire mapping', () => {
  it('maps a secret_request question and drops one with nothing to fill', () => {
    const q = toPendingQuestion({ id: 'q', session_id: 's', tool_call_id: 'c', questions: [{ question: 'x', header: 'Secrets' }], kind: 'secret_request', secret: CARD })
    expect(q?.kind).toBe('secret_request')
    expect(q?.secret?.keys.map((k) => k.state)).toEqual(['new', 'elsewhere', 'available'])
    const none = toPendingQuestion({ id: 'q', questions: [{ question: 'x' }], kind: 'secret_request', secret: { ...CARD, keys: [CARD.keys[2]] } })
    expect(none).toBeNull()
  })

  it('reads the summary lines back from every result shape', () => {
    expect(secretSummaryFromResult('The user declined to provide A_KEY. Do not ask …')).toEqual(['Declined'])
    expect(secretSummaryFromResult('The user saved new values for K. Use them …')).toEqual(['Replaced: K'])
    expect(secretSummaryFromResult('Already available in this project: K. Use them …')).toEqual(['Already available: K'])
  })
})

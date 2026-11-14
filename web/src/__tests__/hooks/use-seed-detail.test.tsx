import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { DetailSeed } from '@/hooks/use-seed-detail'
import { queryKeys } from '@/queries'
import { DISPLAY_PREFS_STORAGE_KEY, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

const SESSIONS_KEY = queryKeys.session.sessions.workspace('__all_coding__', 'activity')

function page(ids: string[]) {
  return {
    pages: [{ data: ids.map((id) => ({ id, title: id, agent_name: 'lead', created_at: '2026-11-14T09:00:00Z', updated_at: '2026-11-14T09:00:00Z' })), next_cursor: null, has_more: false }],
    pageParams: [null],
  }
}

/** A launch with nothing stored: a new install, or one that never changed a display setting. */
async function launchWithNothingStored() {
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
  await useDisplayPrefsStore.persist.rehydrate()
}

function mount(client: QueryClient) {
  render(<QueryClientProvider client={client}><DetailSeed /></QueryClientProvider>)
}

function clientWith(sessions?: string[]) {
  // Never resolves on its own: the list arrives only when a test puts it in the cache.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, queryFn: () => new Promise(() => {}) } } })
  if (sessions) client.setQueryData(SESSIONS_KEY, page(sessions))
  return client
}

afterEach(() => {
  cleanup()
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed', detailSeeded: true })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
})

describe('DetailSeed', () => {
  it('keeps Full on an install whose server already has sessions', async () => {
    await launchWithNothingStored()

    mount(clientWith(['a', 'b']))

    expect(useDisplayPrefsStore.getState()).toMatchObject({ transcriptStyle: 'detailed', detailSeeded: true })
  })

  it('leaves a new install in Simple once its empty session list arrives', async () => {
    await launchWithNothingStored()
    const client = clientWith()

    mount(client)
    // Still loading: nothing is decided yet.
    expect(useDisplayPrefsStore.getState().detailSeeded).toBe(false)

    act(() => { client.setQueryData(SESSIONS_KEY, page([])) })

    await waitFor(() => expect(useDisplayPrefsStore.getState().detailSeeded).toBe(true))
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
  })

  it('does not touch a style someone picked', () => {
    useDisplayPrefsStore.getState().setTranscriptStyle('reader')

    mount(clientWith(['a']))

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
  })
})

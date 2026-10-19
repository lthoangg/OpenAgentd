import { afterEach, describe, expect, it } from 'bun:test'

import { DISPLAY_PREFS_STORAGE_KEY, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed', newSessionComposer: 'centered' })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
})

describe('useDisplayPrefsStore — transcript style', () => {
  it('starts detailed and remembers a switch to reader', () => {
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')

    useDisplayPrefsStore.getState().setTranscriptStyle('reader')

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'reader', newSessionComposer: 'centered' })
  })

  it('falls back to detailed for a stored style it does not know', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'compact' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')
  })
})

describe('useDisplayPrefsStore — new session composer', () => {
  it('starts centered and remembers a switch to floating', () => {
    expect(useDisplayPrefsStore.getState().newSessionComposer).toBe('centered')

    useDisplayPrefsStore.getState().setNewSessionComposer('floating')

    expect(useDisplayPrefsStore.getState().newSessionComposer).toBe('floating')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state.newSessionComposer).toBe('floating')
  })

  it('falls back to centered for a stored value it does not know, keeping the transcript style', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'reader', newSessionComposer: 'sideways' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect(useDisplayPrefsStore.getState().newSessionComposer).toBe('centered')
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
  })
})

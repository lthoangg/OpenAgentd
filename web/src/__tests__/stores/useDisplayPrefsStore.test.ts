import { afterEach, describe, expect, it } from 'bun:test'

import { DISPLAY_PREFS_STORAGE_KEY, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
})

describe('useDisplayPrefsStore — transcript style', () => {
  it('starts detailed and remembers a switch to reader', () => {
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')

    useDisplayPrefsStore.getState().setTranscriptStyle('reader')

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'reader', textSize: 'default', previewOpen: 'panel', diffLayout: 'unified' })
  })

  it('falls back to detailed for a stored style it does not know', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'compact' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')
  })
})

describe('useDisplayPrefsStore — removed new session composer setting', () => {
  it('drops a v3.18.0 newSessionComposer value on load and never writes it back', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'reader', newSessionComposer: 'floating' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect('newSessionComposer' in useDisplayPrefsStore.getState()).toBe(false)
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')

    useDisplayPrefsStore.getState().setTranscriptStyle('detailed')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'detailed', textSize: 'default', previewOpen: 'panel', diffLayout: 'unified' })
  })
})

describe('useDisplayPrefsStore — where previews open', () => {
  it('opens in the Review panel by default, remembers On click, and reads an unknown value as the default', async () => {
    expect(useDisplayPrefsStore.getState().previewOpen).toBe('panel')
    useDisplayPrefsStore.getState().setPreviewOpen('click')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state.previewOpen).toBe('click')

    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { previewOpen: 'tab' }, version: 0 }))
    await useDisplayPrefsStore.persist.rehydrate()
    expect(useDisplayPrefsStore.getState().previewOpen).toBe('panel')
  })
})

describe('useDisplayPrefsStore — diff layout', () => {
  afterEach(() => { useDisplayPrefsStore.setState({ diffLayout: 'unified' }) })

  it('starts unified, remembers side by side, and reads an unknown value as unified', async () => {
    expect(useDisplayPrefsStore.getState().diffLayout).toBe('unified')
    useDisplayPrefsStore.getState().setDiffLayout('split')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state.diffLayout).toBe('split')

    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { diffLayout: 'columns' }, version: 0 }))
    await useDisplayPrefsStore.persist.rehydrate()
    expect(useDisplayPrefsStore.getState().diffLayout).toBe('unified')
  })
})

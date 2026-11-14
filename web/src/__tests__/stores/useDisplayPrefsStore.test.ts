import { afterEach, describe, expect, it } from 'bun:test'

import { DISPLAY_PREFS_STORAGE_KEY, TRANSCRIPT_STYLES, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

afterEach(() => {
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed', detailSeeded: true })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
})

/** The store as a launch finds it: whatever is in localStorage, read afresh. */
async function launch(stored?: Record<string, unknown>) {
  if (stored) localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: stored, version: 0 }))
  else localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
  await useDisplayPrefsStore.persist.rehydrate()
  return useDisplayPrefsStore.getState()
}

describe('useDisplayPrefsStore — Detail on a new install and on one that exists', () => {
  it('starts in Simple with nothing stored, and stays there once the server has no sessions', async () => {
    expect((await launch()).transcriptStyle).toBe('reader')
    expect(useDisplayPrefsStore.getState().detailSeeded).toBe(false)

    useDisplayPrefsStore.getState().seedDetail(false)

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toMatchObject({ transcriptStyle: 'reader', detailSeeded: true })
  })

  it('keeps Full on an install that has sessions but never stored a display setting', async () => {
    await launch()

    useDisplayPrefsStore.getState().seedDetail(true)

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')
    // Written, so the next launch does not ask again.
    expect((await launch(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY)!).state)).transcriptStyle).toBe('detailed')
  })

  it('never overrides a stored pick, whichever it is', async () => {
    for (const style of ['detailed', 'reader'] as const) {
      // What every earlier version wrote: no seeded flag.
      expect((await launch({ transcriptStyle: style, textSize: 'default', previewOpen: 'panel', diffLayout: 'unified' })).detailSeeded).toBe(true)
      useDisplayPrefsStore.getState().seedDetail(style === 'reader')
      expect(useDisplayPrefsStore.getState().transcriptStyle).toBe(style)
    }
  })

  it('never overrides a pick made before the sessions arrived', async () => {
    await launch()
    useDisplayPrefsStore.getState().setTranscriptStyle('detailed')
    useDisplayPrefsStore.getState().seedDetail(false)
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')

    await launch()
    useDisplayPrefsStore.getState().toggleTranscriptStyle()
    useDisplayPrefsStore.getState().seedDetail(false)
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')
  })

  it('names the two levels Simple and Full, Simple first', () => {
    expect(TRANSCRIPT_STYLES).toEqual([{ value: 'reader', label: 'Simple' }, { value: 'detailed', label: 'Full' }])
  })
})

describe('useDisplayPrefsStore — transcript style', () => {
  it('remembers a switch to reader', () => {
    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('detailed')

    useDisplayPrefsStore.getState().setTranscriptStyle('reader')

    expect(useDisplayPrefsStore.getState().transcriptStyle).toBe('reader')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'reader', detailSeeded: true, textSize: 'default', previewOpen: 'panel', diffLayout: 'unified' })
  })

  it('reads a stored style it does not know as Full, what that install showed', async () => {
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
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'detailed', detailSeeded: true, textSize: 'default', previewOpen: 'panel', diffLayout: 'unified' })
  })
})

describe('useDisplayPrefsStore — where previews open', () => {
  it('opens in the Review panel by default, remembers Manually, and reads an unknown value as the default', async () => {
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

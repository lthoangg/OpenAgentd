import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'about', dirtyDrafts: {}, pendingNavigation: null })
})

it('does not close or navigate away from unsaved work until discarded', () => {
  useSettingsStore.setState({ open: true, section: 'sessions' })
  renderHook(() => useUnsavedSettings(true))
  act(() => useSettingsStore.getState().setSection('models'))
  expect(useSettingsStore.getState().section).toBe('sessions')
  expect(useSettingsStore.getState().pendingNavigation).not.toBeNull()
  act(() => useSettingsStore.getState().resolvePendingNavigation(false))
  expect(useSettingsStore.getState().section).toBe('sessions')
  act(() => useSettingsStore.getState().closeSettings())
  expect(useSettingsStore.getState().open).toBe(true)
  act(() => useSettingsStore.getState().resolvePendingNavigation(true))
  expect(useSettingsStore.getState().open).toBe(false)
})

it('opens on the phone section list unless a section is named', () => {
  act(() => useSettingsStore.getState().openSettings())
  expect(useSettingsStore.getState().mobileView).toBe('index')
  act(() => useSettingsStore.getState().closeSettings())
  act(() => useSettingsStore.getState().openSettings('models'))
  expect(useSettingsStore.getState().mobileView).toBe('section')
  expect(useSettingsStore.getState().section).toBe('models')
})

it('asks before going back to the phone section list with unsaved work', () => {
  useSettingsStore.setState({ open: true, section: 'sessions', mobileView: 'section' })
  renderHook(() => useUnsavedSettings(true))
  act(() => useSettingsStore.getState().showIndex())
  expect(useSettingsStore.getState().mobileView).toBe('section')
  expect(useSettingsStore.getState().pendingNavigation).toEqual({ index: true })
  act(() => useSettingsStore.getState().resolvePendingNavigation(true))
  expect(useSettingsStore.getState().mobileView).toBe('index')
  expect(useSettingsStore.getState().section).toBe('sessions')
})

it('reopens the last visited section, and General when its id no longer exists', async () => {
  window.localStorage.setItem('oa.settingsStore', JSON.stringify({ state: { section: 'connectors-edit' }, version: 0 }))
  await useSettingsStore.persist.rehydrate()
  expect(useSettingsStore.getState().section).toBe('connectors')

  // An id from before the sections were renamed (Sessions was `titles`).
  window.localStorage.setItem('oa.settingsStore', JSON.stringify({ state: { section: 'titles' }, version: 0 }))
  await useSettingsStore.persist.rehydrate()
  expect(useSettingsStore.getState().section).toBe('general')
})

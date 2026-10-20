import { afterEach, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { parentSection, useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'about', dirtyDrafts: {}, pendingNavigation: null })
})

it('sends the retired sandbox section, still in persisted state, to About', () => {
  expect(parentSection('sandbox' as SettingsSection)).toBe('about')
})

it('sends the split Automation section, still in persisted state, to Workspaces', () => {
  expect(parentSection('automation' as SettingsSection)).toBe('workspaces')
})

it('does not close or navigate away from unsaved work until discarded', () => {
  useSettingsStore.setState({ open: true, section: 'context' })
  renderHook(() => useUnsavedSettings(true))
  act(() => useSettingsStore.getState().setSection('providers'))
  expect(useSettingsStore.getState().section).toBe('context')
  expect(useSettingsStore.getState().pendingNavigation).not.toBeNull()
  act(() => useSettingsStore.getState().resolvePendingNavigation(false))
  expect(useSettingsStore.getState().section).toBe('context')
  act(() => useSettingsStore.getState().closeSettings())
  expect(useSettingsStore.getState().open).toBe(true)
  act(() => useSettingsStore.getState().resolvePendingNavigation(true))
  expect(useSettingsStore.getState().open).toBe(false)
})

it('opens on the phone section list unless a section is named', () => {
  act(() => useSettingsStore.getState().openSettings())
  expect(useSettingsStore.getState().mobileView).toBe('index')
  act(() => useSettingsStore.getState().closeSettings())
  act(() => useSettingsStore.getState().openSettings('providers'))
  expect(useSettingsStore.getState().mobileView).toBe('section')
  expect(useSettingsStore.getState().section).toBe('providers')
})

it('asks before going back to the phone section list with unsaved work', () => {
  useSettingsStore.setState({ open: true, section: 'context', mobileView: 'section' })
  renderHook(() => useUnsavedSettings(true))
  act(() => useSettingsStore.getState().showIndex())
  expect(useSettingsStore.getState().mobileView).toBe('section')
  expect(useSettingsStore.getState().pendingNavigation).toEqual({ index: true })
  act(() => useSettingsStore.getState().resolvePendingNavigation(true))
  expect(useSettingsStore.getState().mobileView).toBe('index')
  expect(useSettingsStore.getState().section).toBe('context')
})

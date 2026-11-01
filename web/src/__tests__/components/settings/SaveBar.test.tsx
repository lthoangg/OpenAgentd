/**
 * SaveBar — the one way a Settings form is saved. Pages get it from
 * SettingsPage; the agent, skill and MCP editors render it under their form.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SaveBar } from '@/components/settings/SaveBar'
import { SettingsPage } from '@/components/settings/SettingsPage'
import type { DraftControls } from '@/components/settings/useSettingsDraft'
import { getPlatform } from '@/hooks/use-platform'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

function draft(overrides: Partial<DraftControls> = {}): DraftControls {
  return { dirty: true, canSave: true, isSaving: false, save: async () => {}, reset: () => {}, ...overrides }
}

describe('SaveBar', () => {
  it('shows nothing until the draft is dirty', () => {
    render(<SaveBar draft={draft({ dirty: false })} onSave={() => {}} />)
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('names the unsaved state and offers Discard… and Save', () => {
    const onSave = mock(() => {})
    render(<SaveBar draft={draft()} onSave={onSave} />)
    const bar = screen.getByRole('region', { name: 'Unsaved changes' })
    expect(bar.textContent).toContain('Unsaved changes')
    expect(screen.getByRole('button', { name: 'Discard…' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('says why Save is blocked, in words, and keeps it disabled', () => {
    render(<SaveBar draft={draft({ canSave: false })} onSave={() => {}} saveBlockedReason="Name is required." />)
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain('Name is required.')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says Saving… while the save runs, and uses a custom label for a new item', () => {
    const saving = render(<SaveBar draft={draft({ canSave: false, isSaving: true })} onSave={() => {}} />)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
    saving.unmount()

    render(<SaveBar draft={draft()} onSave={() => {}} saveLabel="Create skill" />)
    expect(screen.getByRole('button', { name: 'Create skill' })).toBeTruthy()
  })

  it('asks before discarding, then resets the draft', async () => {
    const reset = mock(() => {})
    render(<SaveBar draft={draft({ reset })} onSave={() => {}} discardDescription="Your edits go back." />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard…' }))
    expect(reset).not.toHaveBeenCalled()
    expect(await screen.findByText('Your edits go back.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1))
  })

  it('binds ⌘S / Ctrl+S inside Settings only when asked, and only while Save is possible', () => {
    const mac = getPlatform().os === 'macos'
    const press = (target: Element) => fireEvent.keyDown(target, { key: 's', metaKey: mac, ctrlKey: !mac })

    const onSave = mock(() => {})
    const bound = render(<div data-settings-modal=""><SaveBar shortcut draft={draft()} onSave={onSave} /></div>)
    press(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    bound.unmount()

    const blocked = mock(() => {})
    const disabled = render(<div data-settings-modal=""><SaveBar shortcut draft={draft({ canSave: false })} onSave={blocked} /></div>)
    press(screen.getByRole('button', { name: 'Save' }))
    expect(blocked).not.toHaveBeenCalled()
    disabled.unmount()

    const unbound = mock(() => {})
    render(<div data-settings-modal=""><SaveBar draft={draft()} onSave={unbound} /></div>)
    press(screen.getByRole('button', { name: 'Save' }))
    expect(unbound).not.toHaveBeenCalled()
  })
})

describe('SettingsPage + SaveBar', () => {
  it('renders the same bar for a draft page, with no Save in the header', () => {
    render(
      <SettingsPage title="Context" draft={draft()}>
        <div />
      </SettingsPage>,
    )
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeTruthy()
  })
})

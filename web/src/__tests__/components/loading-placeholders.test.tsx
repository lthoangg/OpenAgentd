/**
 * DESIGN.md → "Loading placeholders wait a beat": skeletons and spinners
 * fade in after `fast` (`oa-fade-in-late`), so a fast load never flashes one.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionRowsSkeleton } from '@/components/Sidebar/SessionRow'
import { SettingsSkeleton } from '@/components/settings/SettingsPage'
import { TelemetrySkeleton } from '@/components/Telemetry/TelemetrySkeleton'
import { TaskListPane } from '@/components/SchedulerPanel/TaskListPane'
import { FilePreviewContent } from '@/components/FileViewerPanel'
import type { WorkspaceFileInfo } from '@/api/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const waitsABeat = (el: Element | null) => el?.classList.contains('oa-fade-in-late') ?? false

describe('loading placeholders wait a beat', () => {
  it('sidebar session skeleton', () => {
    render(<SessionRowsSkeleton />)
    expect(waitsABeat(screen.getByRole('status', { name: 'Loading sessions' }))).toBe(true)
  })

  it('settings skeleton', () => {
    render(<SettingsSkeleton />)
    expect(waitsABeat(screen.getByRole('status', { name: 'Loading settings' }))).toBe(true)
  })

  it('telemetry skeleton', () => {
    const { container } = render(<TelemetrySkeleton />)
    expect(waitsABeat(container.querySelector('[aria-label="Loading usage"]'))).toBe(true)
  })

  it('scheduler task list spinner', () => {
    render(<TaskListPane tasks={[]} isLoading isError={false} selectedTaskId={null} onSelect={() => {}} onDeleted={() => {}} />)
    expect(waitsABeat(screen.getByRole('status'))).toBe(true)
    // The loading copy is still there for screen readers from the start.
    expect(screen.getByText('Loading scheduled tasks…')).toBeTruthy()
  })

  it('file viewer spinner', () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const file: WorkspaceFileInfo = { path: 'src/a.ts', name: 'a.ts', size: 10, mtime: 1, mime: 'text/plain' }
    render(<FilePreviewContent workspace="/w" file={file} />)
    expect(waitsABeat(screen.getByRole('status', { name: 'Loading file' }))).toBe(true)
  })
})

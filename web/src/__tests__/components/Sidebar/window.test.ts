import { describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import {
  openSessionInNewWindow,
  sessionWindowErrorDescription,
  shouldOpenSessionInNewWindow,
} from '@/components/Sidebar/window'

describe('Sidebar helpers', () => {
  it('exports session window helpers used by the component', async () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
    } as React.MouseEvent
    expect(shouldOpenSessionInNewWindow(event, true, 'macos')).toBe(true)
    expect(shouldOpenSessionInNewWindow({ metaKey: false, ctrlKey: true } as React.MouseEvent, true, 'linux')).toBe(true)
    expect(shouldOpenSessionInNewWindow(undefined, true, 'macos')).toBe(false)
    expect(shouldOpenSessionInNewWindow(event, false, 'macos')).toBe(false)

    const invoke = mock(async () => undefined)
    await openSessionInNewWindow({
      session: {
        id: 'session-1',
        title: 'Selected session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      importCore: async () => ({ invoke }),
    })
    expect(invoke).toHaveBeenCalledWith('app_new_window', {
      initialPath: '/session-1',
      initial_path: '/session-1',
    })

    expect(sessionWindowErrorDescription(new Error('boom'), 'fallback')).toBe('boom')
    expect(sessionWindowErrorDescription('nope', 'fallback')).toBe('fallback')
  })
})

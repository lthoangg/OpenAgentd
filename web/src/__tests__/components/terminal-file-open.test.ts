import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openTerminalFileLink } from '@/components/Terminal/terminal-file-open'
import { onOpenWorkspaceFileRequest } from '@/lib/open-file-request'
import { useToastStore } from '@/stores/useToastStore'
import type { FileRef } from '@/utils/file-refs'

const WORKSPACE = '/repo/app'
let opened: FileRef[]
let off: () => void

beforeEach(() => {
  opened = []
  off = onOpenWorkspaceFileRequest((ref) => opened.push(ref))
  useToastStore.setState({ toasts: [] })
})
afterEach(() => off())

describe('openTerminalFileLink', () => {
  it('asks for the workspace-relative file with its line and column', () => {
    expect(openTerminalFileLink({ path: './a.ts', line: 4, column: 2 }, '/repo/app/web', WORKSPACE)).toBe(true)
    expect(opened).toEqual([{ path: 'web/a.ts', line: 4, column: 2 }])
  })

  it('reads a relative path from the workspace root without a cwd', () => {
    expect(openTerminalFileLink({ path: 'src/a.ts' }, null, WORKSPACE)).toBe(true)
    expect(opened).toEqual([{ path: 'src/a.ts' }])
  })

  it('refuses a path outside the workspace and says so', () => {
    expect(openTerminalFileLink({ path: '/etc/hosts', line: 1 }, null, WORKSPACE)).toBe(false)
    expect(opened).toEqual([])
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: 'Outside the workspace' })
  })
})

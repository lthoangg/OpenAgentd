import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { WorkspaceFileInfo } from '@/api/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

let isTauri = false
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri, os: isTauri ? 'macos' : 'linux', isMacOverlay: false }),
}))

let invokeImpl: () => Promise<boolean> = async () => true
const invokeMock = mock(() => invokeImpl())
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const toastPushMock = mock(() => {})
mock.module('@/stores/useToastStore', () => ({
  useToastStore: { getState: () => ({ push: toastPushMock }) },
}))

// ── Modules under test ────────────────────────────────────────────────────────

import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { downloadCodingWorkspaceFile } from '@/lib/coding-workspace-download'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const file: WorkspaceFileInfo = {
  path: 'report.png',
  name: 'report.png',
  size: 1024,
  mtime: 1734556820.1,
  mime: 'image/png',
}

afterEach(() => {
  isTauri = false
  invokeImpl = async () => true
  invokeMock.mockClear()
  toastPushMock.mockClear()
  delete (window as Window & { __OAD_TOKEN__?: string }).__OAD_TOKEN__
})

// ── workspace-download ────────────────────────────────────────────────────────

describe('downloadWorkspaceFile', () => {
  it('invokes save_workspace_file with the authenticated url in Tauri', async () => {
    isTauri = true
    ;(window as Window & { __OAD_TOKEN__?: string }).__OAD_TOKEN__ = 'tok'

    await downloadWorkspaceFile('sid', file)

    expect(invokeMock).toHaveBeenCalledWith('save_workspace_file', {
      request: {
        url: expect.stringContaining('report.png'),
        filename: 'report.png',
      },
    })
    const req = (invokeMock.mock.calls[0] as [string, { request: Record<string, unknown> }])[1].request
    expect(req.url as string).toContain('_token=tok')
    expect(req.base64).toBeUndefined()
  })

  it('shows error toast and does not throw when invoke rejects', async () => {
    isTauri = true
    invokeImpl = async () => { throw new Error('network error') }

    await downloadWorkspaceFile('sid', file) // must not throw

    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'error', title: 'Download failed', description: 'network error' })
    )
  })

  it('uses anchor download outside Tauri', async () => {
    isTauri = false
    let capturedDownload = ''
    const origCreate = document.createElement.bind(document)
    document.createElement = (tag: string) => {
      const el = origCreate(tag)
      if (tag === 'a') {
        Object.defineProperty(el, 'download', { set(v: string) { capturedDownload = v }, get() { return capturedDownload } })
        el.click = () => {}
      }
      return el
    }

    await downloadWorkspaceFile('sid', file)

    expect(invokeMock).not.toHaveBeenCalled()
    expect(capturedDownload).toBe('report.png')
    document.createElement = origCreate
  })
})

// ── coding-workspace-download ─────────────────────────────────────────────────

describe('downloadCodingWorkspaceFile', () => {
  it('invokes save_workspace_file with the url in Tauri', async () => {
    isTauri = true
    ;(window as Window & { __OAD_TOKEN__?: string }).__OAD_TOKEN__ = 'tok2'

    const codingFile: WorkspaceFileInfo = { path: 'main.rs', name: 'main.rs', size: 200, mtime: 0, mime: 'text/plain' }
    await downloadCodingWorkspaceFile('my-workspace', codingFile)

    expect(invokeMock).toHaveBeenCalledWith('save_workspace_file', {
      request: { url: expect.stringContaining('main.rs'), filename: 'main.rs' },
    })
  })

  it('shows error toast when invoke rejects', async () => {
    isTauri = true
    invokeImpl = async () => { throw new Error('timeout') }

    const codingFile: WorkspaceFileInfo = { path: 'src/lib.rs', name: 'lib.rs', size: 100, mtime: 0, mime: 'text/plain' }
    await downloadCodingWorkspaceFile('ws', codingFile) // must not throw

    expect(toastPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'error', description: 'timeout' })
    )
  })
})

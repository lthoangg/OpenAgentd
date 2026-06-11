import { afterEach, describe, expect, it, mock } from 'bun:test'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import type { WorkspaceFileInfo } from '@/api/types'

let isTauri = false
const invokeMock = mock(async () => true)

mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri, os: isTauri ? 'macos' : 'linux', isMacOverlay: isTauri }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const file: WorkspaceFileInfo = {
  path: 'google_qr.png',
  name: 'google_qr.png',
  size: 589,
  mtime: 1734556820.1,
  mime: 'image/png',
}

afterEach(() => {
  isTauri = false
  invokeMock.mockClear()
  delete window.__OAD_TOKEN__
})

describe('downloadWorkspaceFile', () => {
  it('uses native Tauri save command in desktop shell', async () => {
    isTauri = true
    window.__OAD_TOKEN__ = 'secret'

    await downloadWorkspaceFile('sid', file)

    expect(invokeMock).toHaveBeenCalledWith('save_workspace_file', {
      request: {
        url: '/api/team/sid/media/google_qr.png?download=1&_token=secret',
        filename: 'google_qr.png',
      },
    })
  })
})

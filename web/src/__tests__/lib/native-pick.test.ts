/** The phone's native pickers: the right picker per row, picks read back as Files. */
import { describe, expect, it, mock } from 'bun:test'

const opened: unknown[] = []
mock.module('@tauri-apps/plugin-dialog', () => ({
  open: async (options: unknown) => {
    opened.push(options)
    return ['/var/mobile/tmp/IMG_0001.HEIC', '/var/mobile/tmp/notes%20v2.pdf']
  },
}))
mock.module('@tauri-apps/plugin-fs', () => ({ readFile: async () => new Uint8Array([1, 2, 3]) }))

const { describePicked, pickNatively } = await import('@/lib/native-pick')

describe('pickNatively', () => {
  it('opens the media picker for Photos and the document picker for Files', async () => {
    await pickNatively('photos')
    await pickNatively('files')
    expect(opened).toEqual([
      { multiple: true, pickerMode: 'media' },
      { multiple: true, pickerMode: 'document' },
    ])
  })

  it('reads each pick back as a File with its name and type', async () => {
    const files = await pickNatively('files')
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
      ['IMG_0001.HEIC', 'image/heic', 3],
      ['notes v2.pdf', 'application/pdf', 3],
    ])
  })
})

describe('describePicked', () => {
  it('falls back to a generic type for an unknown extension', () => {
    expect(describePicked('content://x/y/report.xyz')).toEqual({ name: 'report.xyz', type: 'application/octet-stream' })
  })
})

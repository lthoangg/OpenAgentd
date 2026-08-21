import { describe, expect, it } from 'bun:test'
import { blobToBase64 } from '@/lib/tauri-download'

// `blobToBase64` feeds `save_workspace_file` for `blob:` sources (attachment
// previews), so it has to survive attachments up to the shell's 100 MB cap.
// The previous implementation appended one character per byte.

describe('blobToBase64', () => {
  it('encodes a small payload', async () => {
    const encoded = await blobToBase64(new Blob([new Uint8Array([72, 101, 108, 108, 111])]))

    expect(encoded).toBe('SGVsbG8=')
  })

  it('encodes an empty blob', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('')
  })

  it('round-trips every byte value across a chunk boundary', async () => {
    // 0x8000 is the chunk size, so this spans three chunks and exercises
    // the seam where a naive split would corrupt the output.
    const bytes = new Uint8Array(0x8000 * 2 + 123)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256

    const decoded = Uint8Array.from(atob(await blobToBase64(new Blob([bytes]))), (c) =>
      c.charCodeAt(0),
    )

    expect(decoded.length).toBe(bytes.length)
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })
})

import { describe, expect, it } from 'bun:test'

import { onComposerInsert, requestComposerInsert } from '@/lib/composer-insert'
import { onOpenWorkspaceFileRequest, requestOpenWorkspaceFile } from '@/lib/open-file-request'

describe('composer insert requests', () => {
  it('delivers the text to listeners until they unsubscribe', () => {
    const seen: string[] = []
    const off = onComposerInsert((text) => seen.push(text))
    requestComposerInsert('one')
    off()
    requestComposerInsert('two')
    expect(seen).toEqual(['one'])
  })

  it('ignores empty text', () => {
    const seen: string[] = []
    const off = onComposerInsert((text) => seen.push(text))
    requestComposerInsert('')
    off()
    expect(seen).toEqual([])
  })
})

describe('open-file requests', () => {
  it('delivers the file reference to listeners', () => {
    const seen: unknown[] = []
    const off = onOpenWorkspaceFileRequest((ref) => seen.push(ref))
    requestOpenWorkspaceFile({ path: 'src/a.ts', line: 4, column: 2 })
    off()
    requestOpenWorkspaceFile({ path: 'src/b.ts' })
    expect(seen).toEqual([{ path: 'src/a.ts', line: 4, column: 2 }])
  })
})

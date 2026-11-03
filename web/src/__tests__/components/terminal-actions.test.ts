import { afterEach, describe, expect, it } from 'bun:test'

import {
  addTerminalSelectionToChat,
  copyTerminalSelection,
  formatTerminalSelection,
  pasteIntoTerminal,
} from '@/components/Terminal/terminal-actions'
import { onComposerInsert } from '@/lib/composer-insert'

describe('formatTerminalSelection', () => {
  it('labels the output and fences it as text', () => {
    expect(formatTerminalSelection('$ make\nok')).toBe('Terminal output:\n```text\n$ make\nok\n```')
  })

  it('drops trailing blank lines and trailing spaces, keeps indentation', () => {
    expect(formatTerminalSelection('  a  \n    b\n\n\n')).toBe('Terminal output:\n```text\n  a\n    b\n```')
  })

  it('uses a longer fence when the output has one', () => {
    expect(formatTerminalSelection('```js\nx\n```')).toBe('Terminal output:\n````text\n```js\nx\n```\n````')
  })

  it('is empty for a blank selection', () => {
    expect(formatTerminalSelection(' \n\n')).toBe('')
  })
})

function fakeTerm(selection: string) {
  const pasted: string[] = []
  return {
    pasted,
    term: {
      hasSelection: () => selection !== '',
      getSelection: () => selection,
      paste: (text: string) => { pasted.push(text) },
    },
  }
}

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
function stubClipboard(clipboard: Partial<Clipboard>) {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
}
afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('terminal clipboard actions', () => {
  it('copies the selection', async () => {
    const written: string[] = []
    stubClipboard({ writeText: async (text) => { written.push(text) } })
    expect(await copyTerminalSelection(fakeTerm('hello').term)).toBe(true)
    expect(written).toEqual(['hello'])
  })

  it('copies nothing without a selection', async () => {
    const written: string[] = []
    stubClipboard({ writeText: async (text) => { written.push(text) } })
    expect(await copyTerminalSelection(fakeTerm('').term)).toBe(false)
    expect(written).toEqual([])
  })

  it('survives a denied clipboard', async () => {
    stubClipboard({ writeText: async () => { throw new Error('denied') }, readText: async () => { throw new Error('denied') } })
    expect(await copyTerminalSelection(fakeTerm('x').term)).toBe(false)
    expect(await pasteIntoTerminal(fakeTerm('').term)).toBe(false)
  })

  it('pastes through term.paste so bracketed paste mode applies', async () => {
    stubClipboard({ readText: async () => 'ls -la' })
    const { term, pasted } = fakeTerm('')
    expect(await pasteIntoTerminal(term)).toBe(true)
    expect(pasted).toEqual(['ls -la'])
  })

  it('does not paste an empty clipboard', async () => {
    stubClipboard({ readText: async () => '' })
    const { term, pasted } = fakeTerm('')
    expect(await pasteIntoTerminal(term)).toBe(false)
    expect(pasted).toEqual([])
  })
})

describe('addTerminalSelectionToChat', () => {
  it('asks the composer to insert the selection as a fenced block', () => {
    const inserted: string[] = []
    const off = onComposerInsert((text) => inserted.push(text))
    expect(addTerminalSelectionToChat(fakeTerm('boom').term)).toBe(true)
    off()
    expect(inserted).toEqual(['Terminal output:\n```text\nboom\n```'])
  })

  it('does nothing without a selection', () => {
    const inserted: string[] = []
    const off = onComposerInsert((text) => inserted.push(text))
    expect(addTerminalSelectionToChat(fakeTerm('').term)).toBe(false)
    off()
    expect(inserted).toEqual([])
  })
})

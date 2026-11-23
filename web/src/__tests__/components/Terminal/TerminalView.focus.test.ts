import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// TerminalView is stubbed app-wide in the tests (it renders store-owned xterm
// DOM), so the wiring is checked on the source, like the viewport test.
const source = readFileSync(
  fileURLToPath(new URL('../../../components/Terminal/TerminalView.tsx', import.meta.url)),
  'utf8',
)

describe('TerminalView focus', () => {
  const attachEnd = '}, [handle, isMobile, sessionId])'
  const attach = source.slice(source.indexOf('// Attach: re-parent'), source.indexOf(attachEnd))

  it('does not focus the terminal from the attach effect', () => {
    expect(attach.length).toBeGreaterThan(0)
    expect(attach).not.toContain('term.focus()')
  })

  it('re-attaches only for a new xterm, not on a status change, which would drop focus', () => {
    // Moving a focused node out and back blurs it: a new shell turned
    // connected right after taking focus, and the next keys went to the chat.
    expect(source).toContain(attachEnd)
  })

  it('leaves focusing to the open-time hook', () => {
    expect(source).toContain('useTerminalAutoFocus(')
  })

  it('wires find, file links and add-to-chat into the terminal view', () => {
    expect(source).toContain('<TerminalFindBar')
    expect(source).toContain('handle.onFindRequest')
    expect(source).toContain('handle.setFileOpener')
    expect(source).toContain('addTerminalSelectionToChat')
  })
})

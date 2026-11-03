import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// TerminalView is stubbed app-wide in the tests (it renders store-owned xterm
// DOM), so the wiring is checked on the source, like the viewport test.
const source = readFileSync(
  fileURLToPath(new URL('../../components/Terminal/TerminalView.tsx', import.meta.url)),
  'utf8',
)

describe('TerminalView focus', () => {
  it('does not focus the terminal from the attach effect, which re-runs on every status change', () => {
    const attach = source.slice(source.indexOf('// Attach: re-parent'), source.indexOf('[handleReady, isMobile, sessionId, status])'))
    expect(attach.length).toBeGreaterThan(0)
    expect(attach).not.toContain('term.focus()')
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

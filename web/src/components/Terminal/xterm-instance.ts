/**
 * xterm.js construction — isolated in its own module so it is the single
 * place that imports @xterm/* (and its CSS, which Bun's test loader cannot
 * process; tests mock this module, see __tests__/setup.ts).
 *
 * Instances are owned by useTerminalStore, NOT by React components:
 * a Terminal created here outlives any TerminalView mount so scrollback
 * and the PTY connection survive tab switches and panel closes.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

import { getPlatform } from '@/hooks/use-platform'
import type { FileRef } from '@/utils/file-refs'
import { addTerminalSelectionToChat, copyTerminalSelection, pasteIntoTerminal } from './terminal-actions'
import { routeTerminalKey, terminalShortcut } from './terminal-keys'
import { createFileLinkProvider, parseOsc7Cwd } from './terminal-links'
import { TERMINAL_MIN_CONTRAST_RATIO, TERMINAL_THEMES, type TerminalResolvedTheme } from './terminal-themes'

export interface XtermHandle {
  term: Terminal
  fit: FitAddon
  /** Find in scrollback; the view's find bar drives it. */
  search?: SearchAddon
  /** The shell's working directory from OSC 7, when the shell reports it. */
  getCwd?: () => string | null
  /** Where ⌘/Ctrl+click on a file path goes; ``null`` detaches it. */
  setFileOpener?: (opener: ((ref: FileRef, cwd: string | null) => void) | null) => void
  /** Called when the user presses the find chord in the terminal. */
  onFindRequest?: (listener: () => void) => () => void
  enableWebgl?: () => void
  disableWebgl?: () => void
}

export function createXterm(options: {
  theme: TerminalResolvedTheme
  fontSize: number
  /**
   * Full CSS font-family stack — build with
   * `buildTerminalFontFamily()` (see `lib/terminal-font.ts`). Nerd-Font-
   * first: users running Powerlevel10k / Starship / oh-my-zsh themes
   * almost certainly have one installed locally (p10k's own
   * recommendation is MesloLGS NF), and a user-supplied exact font name
   * is layered in front of the guess stack — that has to be manual rather
   * than auto-detected (browsers don't
   * expose the OS's installed font list). Plain JetBrains Mono remains
   * the fallback for everyone else.
   */
  fontFamily: string
}): XtermHandle {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: TERMINAL_THEMES[options.theme],
    minimumContrastRatio: TERMINAL_MIN_CONTRAST_RATIO,
    allowProposedApi: true,
    scrollback: 5000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  // Unicode 11 width tables — without this, wide glyphs and emoji in
  // fancy prompts (p10k segments, gitstatus icons) miscount cell widths
  // and the prompt visually smears / misaligns on redraw.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  const search = new SearchAddon()
  term.loadAddon(search)

  // OSC 7 (``file://host/path``): shells that report their cwd let relative
  // paths in output resolve exactly. Best effort: the sequence is optional.
  let cwd: string | null = null
  term.parser.registerOscHandler(7, (data) => {
    const next = parseOsc7Cwd(data)
    if (next) cwd = next
    return true
  })

  // ⌘/Ctrl+click on ``src/foo.ts:42`` opens the file; URLs stay with web-links.
  let fileOpener: ((ref: FileRef, cwd: string | null) => void) | null = null
  term.registerLinkProvider(createFileLinkProvider({
    buffer: () => {
      const active = term.buffer.active
      return { cols: term.cols, length: active.length, getLine: (y) => active.getLine(y) }
    },
    open: (ref) => fileOpener?.(ref, cwd),
  }))

  const findListeners = new Set<() => void>()

  const { os } = getPlatform()
  // Ctrl+K / Ctrl+P skip the shell on Windows/Linux so the palette still opens.
  // The terminal's own chords (find, copy/paste, add to chat) run here and
  // are claimed with preventDefault so no app shortcut also fires.
  term.attachCustomKeyEventHandler((event) => {
    const action = terminalShortcut(event, os, term.hasSelection())
    if (!action) return routeTerminalKey(event, os)
    event.preventDefault()
    if (action === 'find') for (const listener of findListeners) listener()
    else if (action === 'copy') void copyTerminalSelection(term)
    else if (action === 'paste') void pasteIntoTerminal(term)
    else addTerminalSelectionToChat(term)
    return false
  })

  let webglAddon: WebglAddon | null = null

  const enableWebgl = () => {
    if (webglAddon) return
    try {
      webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose()
        webglAddon = null
      })
      term.loadAddon(webglAddon)
    } catch {
      webglAddon = null
    }
  }

  const disableWebgl = () => {
    if (!webglAddon) return
    try {
      webglAddon.dispose()
    } catch {
      // ignore
    }
    webglAddon = null
  }

  return {
    term,
    fit,
    search,
    getCwd: () => cwd,
    setFileOpener: (opener) => { fileOpener = opener },
    onFindRequest: (listener) => {
      findListeners.add(listener)
      return () => { findListeners.delete(listener) }
    },
    enableWebgl,
    disableWebgl,
  }
}

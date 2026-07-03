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
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

import { TERMINAL_THEMES, type TerminalResolvedTheme } from './terminal-themes'

export interface XtermHandle {
  term: Terminal
  fit: FitAddon
}

export function createXterm(options: {
  theme: TerminalResolvedTheme
  fontSize: number
}): XtermHandle {
  const term = new Terminal({
    cursorBlink: true,
    // Nerd-Font-first stack: users running Powerlevel10k / Starship /
    // oh-my-zsh themes almost certainly have one of these installed
    // locally (p10k's own recommendation is MesloLGS NF). WebViews can
    // use locally-installed fonts, so preferring them renders powerline
    // separators and devicons correctly; plain JetBrains Mono remains
    // the fallback for everyone else.
    fontFamily:
      '"MesloLGS NF", "JetBrainsMono Nerd Font", "JetBrainsMono NF", ' +
      '"Hack Nerd Font", "FiraCode Nerd Font", "Symbols Nerd Font Mono", ' +
      '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: options.fontSize,
    theme: TERMINAL_THEMES[options.theme],
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
  return { term, fit }
}

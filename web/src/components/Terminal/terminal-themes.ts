/**
 * xterm color palettes mapped to the app's warm-paper design tokens
 * (see index.css :root.dark / :root.light). Pure data — no xterm import —
 * so the store can swap themes without loading the renderer module
 * (which Bun's test loader can't process because of its CSS import).
 */

import type { ITheme } from '@xterm/xterm'

export type TerminalResolvedTheme = 'dark' | 'light'

const DARK: ITheme = {
  // Matches the wrapper's --color-surface / --color-text (dark) so the canvas
  // and its padding read as one surface.
  background: '#221c16',
  foreground: '#f5ebd8',
  cursor: '#f5ebd8',
  cursorAccent: '#221c16',
  selectionBackground: '#5c4b3680',
  black: '#221c16',
  brightBlack: '#6b645a',
  red: '#e06c58',
  brightRed: '#f08b78',
  green: '#8aa864',
  brightGreen: '#a8c684',
  yellow: '#d9a85f',
  brightYellow: '#f0c27f',
  blue: '#7d9bbd',
  brightBlue: '#9dbbdd',
  magenta: '#b58fb5',
  brightMagenta: '#d5afd5',
  cyan: '#7fb0a8',
  brightCyan: '#9fd0c8',
  white: '#f5ebd8',
  brightWhite: '#faf6ef',
}

const LIGHT: ITheme = {
  background: '#fffdf7',
  foreground: '#1a1714',
  cursor: '#1a1714',
  cursorAccent: '#fffdf7',
  selectionBackground: '#d9cfa980',
  black: '#1a1714',
  brightBlack: '#6e604f',
  red: '#a71c24',
  brightRed: '#b91c1c',
  green: '#15803d',
  brightGreen: '#16a34a',
  yellow: '#a16207',
  brightYellow: '#b77900',
  blue: '#026f9e',
  brightBlue: '#0284c7',
  magenta: '#7c3aed',
  brightMagenta: '#8b5cf6',
  cyan: '#0f766e',
  brightCyan: '#0d9488',
  white: '#f5efdd',
  brightWhite: '#fffdf7',
}

export const TERMINAL_THEMES: Record<TerminalResolvedTheme, ITheme> = {
  dark: DARK,
  light: LIGHT,
}

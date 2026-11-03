/**
 * The slice of xterm's SearchAddon the find bar uses, plus the match
 * decoration colours and the "3 of 12" label. Kept xterm-free (structural
 * types only) so the bar can be tested without the renderer.
 */
import type { TerminalResolvedTheme } from './terminal-themes'

/** Match colours; xterm needs ``#RRGGBB`` strings (no alpha, no CSS vars). */
export interface TerminalSearchDecorations {
  matchBackground: string
  matchBorder: string
  matchOverviewRuler: string
  activeMatchBackground: string
  activeMatchBorder: string
  activeMatchColorOverviewRuler: string
}

export interface TerminalSearchOptions {
  caseSensitive?: boolean
  /** Grow the current match as the query is typed instead of jumping. */
  incremental?: boolean
  decorations?: TerminalSearchDecorations
}

export interface TerminalSearchResults {
  /** ``-1`` once there are too many matches for xterm to number them. */
  resultIndex: number
  resultCount: number
}

export interface TerminalSearch {
  findNext: (term: string, options?: TerminalSearchOptions) => boolean
  findPrevious: (term: string, options?: TerminalSearchOptions) => boolean
  clearDecorations: () => void
  onDidChangeResults: (listener: (results: TerminalSearchResults) => void) => { dispose: () => void }
}

// Warm-paper palette (see terminal-themes): the gold of the yellow ANSI
// colour for the current match, a quieter tint for the rest. Text colour is
// left as is, so each background keeps the theme's text readable.
const DECORATIONS: Record<TerminalResolvedTheme, TerminalSearchDecorations> = {
  dark: {
    matchBackground: '#5c4b36',
    matchBorder: '#7a6444',
    matchOverviewRuler: '#d9a85f',
    activeMatchBackground: '#8a6a2a',
    activeMatchBorder: '#f0c27f',
    activeMatchColorOverviewRuler: '#f0c27f',
  },
  light: {
    matchBackground: '#e8dfb8',
    matchBorder: '#c9b97a',
    matchOverviewRuler: '#a16207',
    activeMatchBackground: '#f3d27a',
    activeMatchBorder: '#a16207',
    activeMatchColorOverviewRuler: '#a16207',
  },
}

export function searchDecorations(theme: TerminalResolvedTheme): TerminalSearchDecorations {
  return DECORATIONS[theme]
}

/** "3 of 12", "No results", or blank while nothing is typed. */
export function formatMatchStatus(query: string, resultIndex: number, resultCount: number): string {
  if (query === '') return ''
  if (resultCount === 0) return 'No results'
  if (resultIndex < 0) return `${resultCount}+`
  return `${resultIndex + 1} of ${resultCount}`
}

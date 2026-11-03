/**
 * Terminal actions shared by the key handler (xterm-instance) and the mobile
 * action sheet (TerminalView): copy, paste, and add the selection to the
 * chat. They take a structural slice of xterm's Terminal, so they are testable
 * without the renderer.
 */
import { requestComposerInsert } from '@/lib/composer-insert'

export interface SelectionTerminal {
  hasSelection: () => boolean
  getSelection: () => string
}

export interface PasteTerminal {
  /** xterm's own paste: applies bracketed-paste mode and feeds ``onData``. */
  paste: (text: string) => void
}

/**
 * The selection as a Markdown block for the composer: ``Terminal output:``
 * and a fenced ``text`` block, fenced long enough to hold any fence in the
 * output. Empty for a blank selection.
 */
export function formatTerminalSelection(selection: string): string {
  const body = selection
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '')
    .replace(/^\n+/, '')
  if (body.trim() === '') return ''
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `Terminal output:\n${fence}text\n${body}\n${fence}`
}

/** Copy the selection to the clipboard; ``false`` with no selection or access. */
export async function copyTerminalSelection(term: SelectionTerminal): Promise<boolean> {
  if (!term.hasSelection()) return false
  try {
    await navigator.clipboard.writeText(term.getSelection())
    return true
  } catch {
    // Clipboard permission denied: nothing to do.
    return false
  }
}

/** Paste the clipboard into the shell through ``term.paste``. */
export async function pasteIntoTerminal(term: PasteTerminal): Promise<boolean> {
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return false
    term.paste(text)
    return true
  } catch {
    return false
  }
}

/** Add the selection to the open session's composer as a fenced block. */
export function addTerminalSelectionToChat(term: SelectionTerminal): boolean {
  if (!term.hasSelection()) return false
  const block = formatTerminalSelection(term.getSelection())
  if (!block) return false
  requestComposerInsert(block)
  return true
}

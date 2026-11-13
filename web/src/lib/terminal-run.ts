/**
 * Run in terminal: a shell code block asks the Review dock to run its command.
 *
 * The chat shell registers a runner while a workspace is attached (a terminal
 * needs one); code blocks anywhere in the app read ``useTerminalRunAvailable``
 * to decide whether to offer the button, and call ``requestTerminalRun`` on a
 * click. A registry rather than a prop or context: the Markdown renderer keeps
 * a module-constant component map, and blocks render in the transcript, the
 * Plan tab and file previews alike.
 */
import { useSyncExternalStore } from 'react'

const SHELL_LANGUAGES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'zsh', 'fish'])

/** A fence language whose content is a command line for a POSIX-style shell. */
export function isShellLanguage(language: string | undefined): boolean {
  return !!language && SHELL_LANGUAGES.has(language.trim().toLowerCase())
}

type TerminalRunner = (command: string) => void

const runners: TerminalRunner[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Offer a runner (the newest one wins); returns the function that withdraws it. */
export function registerTerminalRunner(runner: TerminalRunner): () => void {
  runners.push(runner)
  notify()
  return () => {
    const at = runners.lastIndexOf(runner)
    if (at >= 0) runners.splice(at, 1)
    notify()
  }
}

/** The command as it is sent: without the fence's trailing newline. */
export function normalizeTerminalCommand(command: string): string {
  return command.replace(/\s+$/, '')
}

/** Run ``command`` in the workspace's terminal; ``false`` when nothing can run it. */
export function requestTerminalRun(command: string): boolean {
  const runner = runners[runners.length - 1]
  const text = normalizeTerminalCommand(command)
  if (!runner || text.trim() === '') return false
  runner(text)
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const available = () => runners.length > 0

/** True while a terminal can take a command (a workspace is attached). */
export function useTerminalRunAvailable(): boolean {
  return useSyncExternalStore(subscribe, available, () => false)
}

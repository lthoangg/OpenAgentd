/**
 * A program and its arguments as one line a person can read, and paste into a
 * shell: a word with a space or a shell character is single-quoted, so
 * `--title 'Release notes'` shows where each argument starts and ends. Words
 * made only of letters, digits and `@ % + = : , . / -` stay as they are.
 */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/

function word(text: string): string {
  return PLAIN_WORD.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`
}

export function commandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(word).join(' ')
}

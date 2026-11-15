/**
 * Blocked-file patterns in words.
 *
 * A pattern is matched against a file's full path, and `*` stands for any
 * text, folders included (the backend's `fnmatch` rules). So a folder is
 * blocked by its full path, or by its name between two `**` for that name
 * anywhere.
 */

/** No pattern characters: the text stands for itself. */
const PLAIN = '[^*?\\[\\]/]+'
const NAMED_FILE = new RegExp(`^\\*\\*/(${PLAIN})$`)
const NAME_PREFIX = new RegExp(`^\\*\\*/(${PLAIN})\\*$`)
const EXTENSION = new RegExp(`^\\*\\*/\\*(\\.${PLAIN})$`)
const NAMED_FOLDER = new RegExp(`^\\*\\*/(${PLAIN})/\\*\\*$`)
/** A full path (`/…` or `C:/…`) with no pattern characters, then `/**`. */
const ONE_FOLDER = new RegExp(`^(?:[A-Za-z]:)?(?:/${PLAIN})*/(${PLAIN})/\\*\\*$`)

/** What a pattern blocks, as a sentence a person can check. */
export function describePattern(pattern: string): string {
  const p = pattern.trim()
  if (!p) return 'New pattern'
  let m = NAMED_FOLDER.exec(p)
  if (m) return `Everything in any folder named ${m[1]}`
  m = EXTENSION.exec(p)
  if (m) return `Any ${m[1]} file`
  m = NAMED_FILE.exec(p)
  if (m) return `Any file named ${m[1]}`
  m = NAME_PREFIX.exec(p)
  if (m) return `Any file whose name starts with ${m[1]}`
  m = ONE_FOLDER.exec(p)
  if (m) return `Everything in ${m[1]}`
  return 'Your own pattern'
}

/** The pattern that blocks everything in the folder at `path`. */
export function folderPattern(path: string): string {
  const literal = path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/[[*?]/g, (c) => `[${c}]`)
  return `${literal}/**`
}

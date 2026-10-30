/**
 * A session id in one form. Ids reach the app hyphenated (API rows) and
 * bare (some events), as the desktop shell's `id_key` also handles.
 */
export function sessionKey(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

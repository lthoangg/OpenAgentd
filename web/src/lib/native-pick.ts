/**
 * The phone's own pickers for the composer's + menu: **Photos** opens the
 * system photo library (PHPicker / Android's photo picker) and **Files**
 * the document picker, each straight away, with no "Photo Library / Take
 * Photo / Choose File" menu between (what a web file input shows on iOS).
 *
 * ``tauri-plugin-dialog`` copies each pick into the app's sandbox and adds
 * it to the fs scope; ``tauri-plugin-fs`` reads that copy back, and it
 * becomes a ``File`` for the composer's usual attach path.
 */
import { getPlatform } from '@/hooks/use-platform'

export type NativePickKind = 'photos' | 'files'

/** The iOS and Android apps: the only shells with the native pickers. */
export function canPickNatively(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  webp: 'image/webp',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** The file's name and type from its path or content URI. */
export function describePicked(path: string): { name: string; type: string } {
  const raw = decodeURIComponent(path.split(/[/\\]/).pop() ?? 'file')
  const name = raw || 'file'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return { name, type: MIME_BY_EXTENSION[ext] ?? 'application/octet-stream' }
}

/** Open the photo library or the document picker; the picks as ``File``s (empty when cancelled). */
export async function pickNatively(kind: NativePickKind): Promise<File[]> {
  const [{ open }, { readFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const picked = await open({ multiple: true, pickerMode: kind === 'photos' ? 'media' : 'document' })
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked]
  const files: File[] = []
  for (const path of paths) {
    const bytes = await readFile(path)
    const { name, type } = describePicked(path)
    files.push(new File([bytes], name, { type }))
  }
  return files
}

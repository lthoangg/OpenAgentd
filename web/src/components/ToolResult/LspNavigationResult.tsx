/**
 * An lsp navigation result (definitions, references, implementations,
 * symbols): one row per location, its path opening the file at that line.
 */

import { useContext } from 'react'
import { FileRefButton, FileRefContext } from '../FileRefLink'
import type { FileRef } from '@/utils/file-refs'
import { GenericResult } from './GenericResult'

interface LspLocation {
  name: string | null
  path: string
  position: string
  /** Source line at the location, when the backend included one. */
  code: string | null
}

/**
 * Parse the backend's line format:
 * ``[symbol (kind) [tag] | ]path:line:character[ | source line]``, plus the
 * trailing ``… truncated: …`` note emitted when results exceed the cap.
 */
function parseLspLocations(result: string): { locations: LspLocation[]; note: string | null } {
  const locations: LspLocation[] = []
  let note: string | null = null

  for (const raw of result.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('…')) {
      note = line
      continue
    }
    const parts = line.split(' | ')
    // The location is the first segment ending in :line:character — anything
    // before it is the symbol label, anything after is the source excerpt
    // (rejoined, since code can legitimately contain " | ").
    const index = parts.findIndex((part) => /:\d+:\d+$/.test(part))
    if (index === -1) continue
    const match = parts[index].match(/^(.*):(\d+:\d+)$/)
    if (!match) continue
    locations.push({
      name: index > 0 ? parts.slice(0, index).join(' | ') : null,
      path: match[1],
      position: match[2],
      code: index < parts.length - 1 ? parts.slice(index + 1).join(' | ') : null,
    })
  }

  return { locations, note }
}

/** The ``line:character`` position of a location, as a file reference. */
function locationRef(location: LspLocation): FileRef {
  const [line, column] = location.position.split(':').map(Number)
  return { path: location.path, line, column }
}

function lspCountLabel(operation: string | undefined, count: number): string {
  const singular = count === 1
  if (operation === 'go_to_definition') return `${count} ${singular ? 'definition' : 'definitions'}`
  if (operation === 'find_references') return `${count} ${singular ? 'reference' : 'references'}`
  if (operation === 'document_symbol') return `${count} document ${singular ? 'symbol' : 'symbols'}`
  if (operation === 'workspace_symbol') return `${count} workspace ${singular ? 'symbol' : 'symbols'}`
  if (operation === 'find_implementations') return `${count} ${singular ? 'implementation' : 'implementations'}`
  return `${count} ${singular ? 'location' : 'locations'}`
}

function lspEmptyLabel(operation: string | undefined): string {
  if (operation === 'go_to_definition') return 'No definition found.'
  if (operation === 'find_references') return 'No references found.'
  if (operation === 'find_implementations') return 'No implementations found.'
  return 'No symbols found.'
}

export function LspNavigationResult({
  operation,
  result,
}: {
  operation?: string
  result: string
}) {
  const opener = useContext(FileRefContext)
  if (result.trim() === 'No results.') {
    return (
      <p className="font-mono text-xs leading-relaxed text-(--color-text-muted)">
        {lspEmptyLabel(operation)}
      </p>
    )
  }

  const { locations, note } = parseLspLocations(result)
  if (locations.length === 0) return <GenericResult result={result} />

  return (
    <div className="min-w-0">
      <p className="mb-1 font-mono text-xs md:text-meta text-(--color-text-muted)">
        {lspCountLabel(operation, locations.length)}
      </p>
      <ul className="max-h-[calc(8*1.55em)] min-w-0 space-y-1 overflow-y-auto pr-1 sm:max-h-[calc(10*1.55em)]">
        {locations.map((location, index) => (
          <li
            key={`${location.path}:${location.position}:${location.name ?? ''}:${index}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 font-mono text-xs leading-relaxed"
          >
            <span className="min-w-0 break-words text-(--color-text-2)">
              {location.name && (
                <span className="mr-2 font-semibold text-(--color-text)">
                  {location.name}
                </span>
              )}
              {opener && opener.canOpen({ path: location.path }) ? (
                <FileRefButton fileRef={locationRef(location)} opener={opener} className="text-left">
                  {location.path}
                </FileRefButton>
              ) : location.path}
            </span>
            <span className="shrink-0 text-(--color-accent)">
              {location.position}
            </span>
            {location.code && (
              <span className="col-span-2 min-w-0 truncate text-xs text-(--color-text-muted)">
                {location.code}
              </span>
            )}
          </li>
        ))}
      </ul>
      {note && (
        <p className="mt-1 font-mono text-xs md:text-meta text-(--color-text-muted) italic">
          {note}
        </p>
      )}
    </div>
  )
}

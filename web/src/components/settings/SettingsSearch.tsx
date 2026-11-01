/**
 * Settings search: one field and one result list, used by the desktop
 * sidebar, the icon rail's search dialog and the phone section list.
 *
 * A result is a section or a single setting inside one (see
 * `settings-index.ts`). Choosing a result opens its section; for a setting,
 * the modal then scrolls to it and focuses its control.
 */
import type { KeyboardEvent } from 'react'
import { useState } from 'react'

import { SearchBar } from '@/components/ui/search-bar'
import { cn } from '@/lib/utils'
import type { SettingsSectionDef } from '@/components/settings/sections'
import { searchSettings, type SettingsHit } from '@/components/settings/settings-index'

export interface SettingsSearchState {
  query: string
  setQuery: (query: string) => void
  hits: SettingsHit[]
  /** The query has words in it, so the results replace the section list. */
  searching: boolean
}

export function useSettingsSearch(sections: readonly SettingsSectionDef[]): SettingsSearchState {
  const [query, setQuery] = useState('')
  return { query, setQuery, hits: searchSettings(query, sections), searching: query.trim() !== '' }
}

export function SettingsSearchField({
  search,
  onOpen,
  autoFocus,
  wrapperClassName,
}: {
  search: SettingsSearchState
  onOpen: (hit: SettingsHit) => void
  autoFocus?: boolean
  wrapperClassName?: string
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter opens the first result, so typing a word then Enter jumps there.
    if (event.key === 'Enter' && search.hits[0]) {
      event.preventDefault()
      onOpen(search.hits[0])
    }
  }
  return (
    <SearchBar
      value={search.query}
      onChange={(event) => search.setQuery(event.target.value)}
      placeholder="Search settings"
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      wrapperClassName={wrapperClassName}
    />
  )
}

export function SettingsSearchResults({
  search,
  onOpen,
  className,
}: {
  search: SettingsSearchState
  onOpen: (hit: SettingsHit) => void
  className?: string
}) {
  if (!search.searching) return null
  if (search.hits.length === 0) {
    return <p className={cn('px-2.5 pt-4 text-xs text-(--color-text-muted)', className)}>No settings match “{search.query.trim()}”.</p>
  }
  return (
    <ul aria-label="Search results" className={cn('flex flex-col gap-0.5 pt-2', className)}>
      {search.hits.map((hit) => (
        <li key={`${hit.kind}:${hit.section}:${hit.label}`}>
          <button
            type="button"
            // The name is the result itself; the section and description are context.
            aria-label={hit.kind === 'section' ? hit.label : `${hit.label}, in ${hit.sectionLabel}`}
            onClick={() => onOpen(hit)}
            className={cn(
              'flex min-h-9 w-full flex-col justify-center rounded-sm px-2.5 py-1 text-left transition-colors duration-(--motion-instant)',
              'text-(--color-text-2) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
            )}
          >
            <span className="truncate text-xs font-medium text-(--color-text)">{hit.label}</span>
            <span className="truncate text-meta text-(--color-text-muted)">
              {hit.kind === 'section' ? hit.description : hit.sectionLabel}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

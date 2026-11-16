/**
 * A web_search result: each hit's title as a link, its host, and a short
 * snippet. Output that is not a list of hits reads as generic text.
 */

import { ExternalLink, Globe } from 'lucide-react'
import { GenericResult, tryParseJSON } from './GenericResult'

interface WebSearchResult {
  title?: string
  href?: string
  url?: string
  body?: string
  snippet?: string
}

/** Truncate a string to `max` chars, appending "…" if cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** Best-effort hostname extraction without throwing. */
function hostname(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return href
  }
}

export function WebSearchResult({ result }: { result: string }) {
  const parsed = tryParseJSON(result)

  // Normalise to array
  const items: WebSearchResult[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? [parsed as WebSearchResult]
      : []

  if (items.length === 0) {
    return <GenericResult result={result} />
  }

  return (
    <ul className="max-h-40 space-y-2 overflow-y-auto pr-1 sm:max-h-64">
      {items.map((item, i) => {
        const link = item.href ?? item.url ?? ''
        const title = item.title ?? link
        const summary = item.body ?? item.snippet ?? ''

        return (
          <li key={i} className="group flex flex-col gap-0.5">
            {/* Title + link */}
            <div className="flex items-start gap-1.5">
              <Globe size={12} className="mt-0.5 shrink-0 text-(--color-text-muted)" />
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-hit relative min-w-0 flex-1 text-xs font-medium leading-snug break-words text-(--color-text) underline decoration-(--color-border-strong) underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-(--focus-ring)"
                >
                  {title}
                </a>
              ) : (
                <span className="min-w-0 flex-1 text-xs font-medium leading-snug break-words text-(--color-text)">
                  {title}
                </span>
              )}
            </div>

            {/* Hostname pill */}
            {link && (
              <div className="flex items-center gap-1 pl-5">
                <ExternalLink size={12} className="text-(--color-text-muted)" />
                <span className="font-mono text-xs md:text-meta text-(--color-text-muted)">
                  {hostname(link)}
                </span>
              </div>
            )}

            {/* Snippet */}
            {summary && (
              <p className="pl-5 text-xs leading-relaxed text-(--color-text-2)">
                {truncate(summary, 200)}
              </p>
            )}

            {/* Divider (not after last) */}
            {i < items.length - 1 && (
              <hr className="mt-1.5 border-t border-(--color-border)" />
            )}
          </li>
        )
      })}
    </ul>
  )
}

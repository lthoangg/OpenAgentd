/**
 * Pure helpers for the InputBar's @-mention picker.
 *
 * Kept in a separate module so InputBar.tsx can stay HMR-friendly under
 * react-refresh (which forbids non-component exports from .tsx files).
 */
import fuzzysort from 'fuzzysort'

/**
 * A workspace file or folder available to the user as an `@`-mention.
 * Paths are POSIX-separated and relative to the workspace root.
 */
export interface FileRef {
  path: string
  name: string
  type: 'file' | 'directory'
}

/**
 * Precomputed token sets used by {@link findCommittedMentions} to resolve
 * ``@mention`` tokens in O(1). Building these from a large ``fileRefs`` list
 * is O(refs); doing it on every keystroke is the dominant cost when the input
 * has thousands of workspace files, so callers that re-run resolution on every
 * change (the overlay) should build this once via {@link buildMentionLookup}
 * and memoize it against ``fileRefs``.
 */
export interface MentionLookup {
  /** All valid mention tokens: ``@path`` (and ``@path/`` for directories). */
  valid: Set<string>
  /** File-only ``@path`` bases, used to validate ``@path#L1-L2`` line refs. */
  validLineBases: Set<string>
}

/**
 * Build the {@link MentionLookup} for a set of workspace refs. O(refs).
 * Memoize the result against the ``fileRefs`` identity so per-keystroke
 * resolution stays O(1) instead of rebuilding both sets every change.
 */
export function buildMentionLookup(refs: readonly FileRef[]): MentionLookup {
  const valid = new Set<string>()
  const validLineBases = new Set<string>()
  for (const r of refs) {
    if (r.type === 'directory') {
      valid.add(`@${r.path}`)
      valid.add(`@${r.path}/`)
    } else {
      valid.add(`@${r.path}`)
      validLineBases.add(`@${r.path}`)
    }
  }
  return { valid, validLineBases }
}

function isMentionLookup(value: unknown): value is MentionLookup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'valid' in value &&
    (value as { valid: unknown }).valid instanceof Set
  )
}

/**
 * Find an active `@token` immediately to the left of the caret.
 *
 * Returns the start/end indices in ``value`` and the partial token (the chars
 * typed after the `@`). Returns ``null`` when the caret is not inside an
 * `@`-mention context — that is, when:
 *   - there is no `@` before the caret, or
 *   - the `@` is not preceded by whitespace or string-start, or
 *   - the token contains whitespace (the mention has been "closed").
 *
 * This is the same heuristic used by opencode/Claude/Cursor: trigger on `@`
 * after whitespace, end the trigger on the next whitespace.
 */
export function findActiveMention(
  value: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  // Scan left from the caret until we hit whitespace or `@`. Anything else
  // is part of the token-in-progress.
  let i = caret
  while (i > 0) {
    const ch = value.charAt(i - 1)
    if (ch === '@') {
      const before = i >= 2 ? value.charAt(i - 2) : ''
      const atStart = i === 1
      if (atStart || /\s/.test(before)) {
        return { start: i - 1, end: caret, query: value.slice(i, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export interface MentionRange {
  path: string
  start: number
  end: number
}

/**
 * Find all character ranges of explicitly selected mention paths in the text value.
 * Sorts by path length descending to avoid matching substrings in overlapping paths.
 */
export function getExplicitMentionRanges(
  value: string,
  selectedMentionPaths?: string[],
): MentionRange[] {
  const ranges: MentionRange[] = []
  if (!selectedMentionPaths || selectedMentionPaths.length === 0) return ranges

  const sortedPaths = [...selectedMentionPaths].sort((a, b) => b.length - a.length)

  for (const path of sortedPaths) {
    // Try the directory token first (@path/) so that when both "src" and
    // "src/api.ts" are in the list, the longer token wins and the shorter
    // one is later skipped by the overlap check.
    const tokens = [`@${path}/`, `@${path}`]
    for (const token of tokens) {
      const isDirToken = token.endsWith('/')
      let idx = value.indexOf(token)
      while (idx !== -1) {
        const before = idx > 0 ? value.charAt(idx - 1) : ''
        const isValidBefore = idx === 0 || /\s|["'([{,]/.test(before)
        if (isValidBefore) {
          const end = idx + token.length
          // For file tokens (no trailing slash) also require that the next
          // character is not a path-continuing character — otherwise "@src"
          // would be matched as a sub-span of "@src/api.ts".
          const charAfter = value.charAt(end)
          const isValidAfter = isDirToken || charAfter === '' || /[\s#"')\]},]/.test(charAfter)
          if (isValidAfter) {
            const overlaps = ranges.some(
              (r) => (idx >= r.start && idx < r.end) || (end > r.start && end <= r.end),
            )
            if (!overlaps) {
              ranges.push({ path, start: idx, end })
            }
          }
        }
        idx = value.indexOf(token, idx + 1)
      }
    }
  }

  return ranges.sort((a, b) => a.start - b.start)
}

/**
 * Find every `@mention` token in ``value`` that has been "committed".
 *
 * Two modes:
 *
 * **Explicit-list mode** (when ``mentions`` is provided): only returns ranges
 * for paths in the ``mentions`` array, optionally validated against ``refs``.
 * Used by the compositor overlay (InputBar) and for submitted messages that
 * carry ``extra.mentions``.
 *
 * **Scanner mode** (when ``mentions`` is ``undefined``): scans the text for
 * any ``@token`` pattern (@ preceded by whitespace/start, terminated by
 * whitespace). Optionally validates each token against ``refs`` when provided.
 * Used for rendering historical messages that pre-date the explicit mention
 * list, and for the UserBubble where no mentions metadata is available.
 *
 * Callers may pass an ``activeRange`` to exclude the token currently being
 * typed, so a chip doesn't materialise on every keystroke.
 *
 * Returned ranges are sorted left-to-right and never overlap.
 */
export function findCommittedMentions(
  value: string,
  activeRange?: { start: number; end: number } | null,
  refs?: readonly FileRef[] | MentionLookup,
  mentions?: string[],
): { start: number; end: number }[] {
  const lookup = refs
    ? isMentionLookup(refs)
      ? refs
      : buildMentionLookup(refs)
    : null

  // ── Explicit-list mode ────────────────────────────────────────────────
  if (mentions !== undefined) {
    const explicitRanges = getExplicitMentionRanges(value, mentions)

    const validatedRanges = explicitRanges.filter((r) => {
      if (!lookup) return true
      const token = `@${r.path}`
      const baseToken = token.replace(/#L\d+(?:-L?\d+)?$/, '')
      const hasFull = lookup.valid.has(token) || lookup.valid.has(token + '/')
      const hasBase = baseToken !== token && lookup.validLineBases.has(baseToken)
      return hasFull || hasBase
    })

    if (activeRange) {
      return validatedRanges
        .filter((r) => !(activeRange.start >= r.start && activeRange.start < r.end))
        .map((r) => ({ start: r.start, end: r.end }))
    }
    return validatedRanges.map((r) => ({ start: r.start, end: r.end }))
  }

  // ── Scanner mode (no explicit mentions list) ──────────────────────────
  // Walk the text looking for @ tokens. Used by UserBubble for historical
  // messages that may not have an explicit mentions list in their metadata.
  const out: { start: number; end: number }[] = []
  for (let i = 0; i < value.length; i++) {
    if (value.charAt(i) !== '@') continue
    const before = i > 0 ? value.charAt(i - 1) : ''
    if (i !== 0 && !/\s/.test(before)) continue

    let j = i + 1
    while (j < value.length && !/\s/.test(value.charAt(j))) j++

    // Strip trailing sentence punctuation so the chip ends at the path.
    let end = j
    while (end > i + 1 && /[,.;:!?)]/.test(value.charAt(end - 1))) end--

    if (end === i + 1) continue

    if (activeRange && activeRange.start === i) {
      i = j
      continue
    }

    // Validate against lookup when refs are available.
    if (lookup) {
      const token = value.slice(i, end)
      const baseToken = token.replace(/#L\d+(?:-L?\d+)?$/, '')
      if (
        !lookup.valid.has(token)
        && !(baseToken !== token && lookup.validLineBases.has(baseToken))
      ) {
        i = j
        continue
      }
    }

    out.push({ start: i, end })
    i = j
  }
  return out
}

/**
 * Rank and filter a flat list of files/folders for the `@`-mention picker.
 *
 * Behaviour:
 *
 *  Empty query (just `@` typed):
 *    - Top-level folders (no slash in ``path``) first, alphabetically.
 *    - Then everything else in given order (files first, deeper dirs after).
 *    Makes the picker a discoverable folder browser when the user doesn't
 *    yet know what to type.
 *
 *  Non-empty query:
 *    Fuzzy *subsequence* match against the path. Each query character must
 *    appear in the path, in order, but not necessarily contiguously — so
 *    ``dockcom`` matches ``docker-compose.yml``. Backed by ``fuzzysort``,
 *    which scores consecutive runs and word-boundary matches highest.
 *
 *    On top of fuzzysort's score we apply a small directory bonus: a
 *    directory whose ``name`` (or path) matches gets surfaced above its
 *    children when scores are otherwise close. This preserves the
 *    "I typed `src` so I probably want the `src` directory" intuition.
 *
 * Pure and stable — same input always yields the same output. Safe to call
 * from a ``useMemo`` on every keystroke; cost is dominated by fuzzysort
 * which has been engineered for this exact workload.
 */
export function rankFileRefs(
  refs: readonly FileRef[],
  rawQuery: string,
  limit: number,
): FileRef[] {
  const query = rawQuery.trim()

  if (!query) {
    // Empty query: top-level folders first (so `@<Enter>` browses the
    // workspace root), then everything else in given order.
    const topDirs: FileRef[] = []
    const rest: FileRef[] = []
    for (const ref of refs) {
      if (ref.type === 'directory' && !ref.path.includes('/')) topDirs.push(ref)
      else rest.push(ref)
    }
    topDirs.sort((a, b) => a.name.localeCompare(b.name))
    return [...topDirs, ...rest].slice(0, limit)
  }

  // Fuzzysort scores in [0, 1] with higher = better. We adjust the score so
  // a directory whose own name is a strong match comes above its children
  // when the two are otherwise similar — fuzzysort doesn't know that
  // ``src`` (the dir) is a different concept from ``src/foo.ts``, but the
  // user typing ``src`` usually does mean the dir.
  //
  // Bonuses are small enough that they don't override a genuinely better
  // fuzzy match elsewhere (e.g. typing ``api`` still surfaces ``api.ts``
  // above an unrelated ``apidocs/`` dir).
  const lowerQuery = query.toLowerCase()
  const results = fuzzysort.go(query, refs, {
    key: 'path',
    // Over-fetch a little so the dir bonus can reshuffle the head.
    limit: limit * 2,
    threshold: 0.2, // drop very weak matches; tuned to feel snappy
  })

  const adjusted = results.map((r) => {
    const ref = r.obj
    let score = r.score
    if (ref.type === 'directory') {
      const lowerName = ref.name.toLowerCase()
      if (lowerName === lowerQuery) score += 0.5      // exact dir-name match
      else if (lowerName.startsWith(lowerQuery)) score += 0.15
      else score += 0.05                              // any dir match
    }
    return { ref, score }
  })

  adjusted.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score // higher score first
    // Tie-break: shorter path wins — closer to the workspace root.
    if (a.ref.path.length !== b.ref.path.length) {
      return a.ref.path.length - b.ref.path.length
    }
    return a.ref.path.localeCompare(b.ref.path)
  })

  return adjusted.slice(0, limit).map((s) => s.ref)
}

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

/**
 * Find every `@mention` token in ``value`` that has been "committed" —
 * i.e. terminated by whitespace or end-of-string **and** (when ``refs``
 * is provided) resolves to a known workspace file or folder.
 *
 * Used by the highlight overlay to paint colored backgrounds behind each
 * mention. Callers may pass an ``activeRange`` to exclude the token at the
 * caret, so a chip doesn't materialise on every keystroke while the user
 * is still picking from the menu.
 *
 * Rules (mirror ``findActiveMention``):
 *   - `@` must be at the start of the string or after whitespace
 *     (so ``user@host.com`` is ignored).
 *   - The token runs from the `@` to the next whitespace.
 *   - A bare `@` with nothing after it is ignored.
 *   - Trailing sentence punctuation (``,`` ``.`` ``;`` ``:`` ``!`` ``?``
 *     ``)``) is stripped before resolution so "look at @README.md, please"
 *     renders one chip over ``@README.md`` and leaves the comma plain.
 *   - When ``refs`` is provided, the post-punctuation token must match a
 *     ref's ``@${path}`` (file) or ``@${path}/`` (directory) exactly.
 *     Unresolved tokens — ``@@``, ``@nonexistent``, ``@foo@bar`` —
 *     produce no chip. This is the same exact-match semantics opencode
 *     uses for its pill rendering.
 *
 * When ``refs`` is undefined the resolution check is skipped (back-compat
 * with the small number of callers that just want range geometry).
 *
 * Returned ranges are sorted left-to-right and never overlap.
 */
export function findCommittedMentions(
  value: string,
  activeRange?: { start: number; end: number } | null,
  refs?: readonly FileRef[] | MentionLookup,
): { start: number; end: number }[] {
  // Resolve the token sets. Callers that re-run on every keystroke (the
  // overlay) pass a prebuilt {@link MentionLookup} so we don't rebuild both
  // sets — O(refs) — on each change. A raw ``FileRef[]`` is still accepted for
  // one-shot callers and tests; ``undefined`` means syntax-only (no resolution).
  const lookup = refs
    ? isMentionLookup(refs)
      ? refs
      : buildMentionLookup(refs)
    : null
  const valid = lookup?.valid ?? null
  const validLineBases = lookup?.validLineBases ?? null

  const out: { start: number; end: number }[] = []
  for (let i = 0; i < value.length; i++) {
    if (value.charAt(i) !== '@') continue
    const before = i > 0 ? value.charAt(i - 1) : ''
    if (i !== 0 && !/\s/.test(before)) continue

    // Walk forward to the next whitespace (or end).
    let j = i + 1
    while (j < value.length && !/\s/.test(value.charAt(j))) j++

    // Strip a single run of trailing sentence punctuation so the chip
    // ends at the path, not at the surrounding prose. We don't recurse —
    // ".," is uncommon and "@foo)." would mark only the ``)`` as prose;
    // good enough for the realistic cases.
    let end = j
    while (end > i + 1 && /[,.;:!?)]/.test(value.charAt(end - 1))) end--

    // Need at least one character after the `@` to be a real mention.
    if (end === i + 1) continue

    // Skip the actively-edited mention so the chip doesn't flash on every
    // keystroke. The picker already provides feedback there.
    if (activeRange && activeRange.start === i) {
      i = j
      continue
    }

    // Resolution check: only chip tokens that actually resolve to a known
    // ref. This is what kills the ``@@`` / ``@nonexistent`` false positive.
    const token = value.slice(i, end)
    const baseToken = token.replace(/#L\d+(?:-L?\d+)?$/, '')
    if (
      valid
      && !valid.has(token)
      && !(baseToken !== token && validLineBases?.has(baseToken))
    ) {
      i = j
      continue
    }

    out.push({ start: i, end })
    i = j // jump past this token to avoid double-matching inside it
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

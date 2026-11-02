import type { ModelCatalogEntry } from '@/api/types'

/**
 * The levels the run picker offers for a model. Nothing while ``known`` is
 * false (the model list is still the placeholder built from the providers
 * list, whose rows carry no levels), and nothing for a model that declares
 * none or that the registry does not list: a lone "Off" there would save
 * ``none`` over the session's level and is no choice anyway. ``__none__`` is
 * an internal registry marker, never a level to pick.
 */
export function pickableThinkingLevels(entry: ModelCatalogEntry | undefined, known: boolean): string[] {
  if (!known || !entry) return []
  // An older server, or a partial entry, may leave the list out.
  const levels = (entry.thinking_levels ?? []).filter((value) => value !== '__none__')
  return levels.length === 1 && levels[0] === 'none' ? [] : levels
}

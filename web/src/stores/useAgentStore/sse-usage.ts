/**
 * Token and cost accounting from the stream's ``usage`` events: per call,
 * per turn, and across a compaction.
 */
import { ensureAgent } from './helpers'
import type { StoreSet } from './types'

export function onUsage(set: StoreSet, d: Record<string, unknown>) {
  const meta = d.metadata as Record<string, unknown> | undefined
  const agent = (meta?.agent as string) ?? (d.agent as string)
  if (!agent) return
  set((draft) => {
    ensureAgent(draft, agent)
    const stream = draft.agentStreams[agent]
    const u = stream.usage
    const promptTokens = (d.prompt_tokens as number) || 0
    const completionTokens = (d.completion_tokens as number) || 0
    const cachedTokens = d.cached_tokens as number | undefined
    const cachePercent = d.cache_percent
    if (meta?.turn_total) {
      u.turnPromptTokens = promptTokens
      u.turnCompletionTokens = completionTokens
      u.turnTotalTokens = (d.total_tokens as number) || (promptTokens + completionTokens)
      u.turnCachedTokens = cachedTokens ?? 0
      return
    }
    // A compaction frame's prompt is the PRE-compaction context the
    // summariser read (and its cache read belongs to that old context),
    // while its output is the compacted summary context. Displaying
    // input as the output of the summarisation turn lets the user
    // immediately see compaction usage (input) being reduced. This
    // mirrors `sumUsageFromMessages` on reload.
    if (meta?.summarization) {
      u.promptTokens   = completionTokens
    } else {
      u.promptTokens   = promptTokens
    }
    // Absent means "this call read nothing from cache" — providers coerce
    // 0 to None, so `usage_to_dict` drops the key. Carrying the previous
    // value forward diverged from `sumUsageFromMessages`, which reads the
    // last message's cache as 0 on reload.
    u.cachedTokens     = cachedTokens ?? 0
    u.cachedPercent    = typeof cachePercent === 'number'
      ? cachePercent
      : cachedTokens !== undefined && promptTokens > 0
      ? Math.round((cachedTokens / promptTokens) * 10000) / 100
      : undefined
    u.completionTokens = u.completionTokens + completionTokens
    u.totalTokens      = u.promptTokens + u.completionTokens
    u.estimatedCostUsd = Math.round(((u.estimatedCostUsd ?? 0) + ((d.estimated_cost_usd as number) || 0)) * 1e8) / 1e8
  })
}

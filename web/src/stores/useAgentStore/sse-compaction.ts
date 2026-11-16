/**
 * Compaction as it streams: the divider a summary run opens, the summary text
 * it fills in, and how it closes.
 */
import { startCompaction, appendCompactionContentInto, endCompaction } from '@/utils/blocks'
import { applyLocalBlockTransform, ensureAgent } from './helpers'
import type { StoreSet } from './types'

export function onSummarizationStart(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  if (!agent) return
  const forced = (d.metadata as Record<string, unknown> | undefined)?.forced === true
  set((draft) => {
    ensureAgent(draft, agent)
    const stream = draft.agentStreams[agent]
    // Auto-compaction can start between model iterations, after this turn
    // has already streamed text/tools into currentBlocks. Seal those
    // blocks first so the divider lands at the actual trigger point;
    // subsequent deltas then remain after it. Everything sealed (plus a
    // newly created "compacting" divider) is local-only, exactly like a
    // `done` flush, so `applyLocalBlockTransform` tags it unsynced the
    // same way.
    const sealed = stream.currentBlocks
    stream.currentBlocks = []
    applyLocalBlockTransform(stream, (blocks) => startCompaction([...blocks, ...sealed], forced))
  })
}

export function onSummarizationContent(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  const text = d.text as string
  if (!agent || !text) return
  set((draft) => {
    ensureAgent(draft, agent)
    const stream = draft.agentStreams[agent]
    appendCompactionContentInto(stream.blocks, text)
  })
}

export function onSummarizationEnd(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  if (!agent) return
  const summary = (d.summary as string | undefined) ?? ''
  const meta = d.metadata as Record<string, unknown> | undefined
  const error = Boolean(meta?.error)
  const forced = meta?.forced === true
  set((draft) => {
    ensureAgent(draft, agent)
    const stream = draft.agentStreams[agent]
    // Usually edits the in-flight divider in place (nothing new to tag).
    // Defensive path: no in-flight "compacting" block existed (e.g.
    // events arrived out of order), so `endCompaction` synthesized a
    // fresh completed one — tag it as unsynced like every other
    // locally-created block.
    applyLocalBlockTransform(stream, (blocks) => endCompaction(blocks, summary, error, forced))
  })
}

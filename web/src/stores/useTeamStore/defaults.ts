/**
 * Default factory for ``AgentStream``.
 *
 * Exported as a function (not a constant) because Zustand + Immer share
 * mutable references; every agent must get its own arrays/objects so
 * that draft mutations on one agent don't bleed into another.
 */
import type { AgentStream } from './types'

export const createDefaultAgentStream = (): AgentStream => ({
  blocks: [],
  currentBlocks: [],
  currentText: '',
  currentThinking: '',
  status: 'idle',
  usage: {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  },
  _completionBase: 0,
  _completionEstimated: 0,
  _turnStartedAt: null,
  model: null,
  lastError: null,
  revertedCount: 0,
  revertedMessages: [],
  _revertedSuffix: [],
  // A stream created *during* an attach replay may legitimately receive a
  // snapshot as its first chunk. Harmless when it doesn't: the block is empty,
  // so replacing "" with the chunk and appending to "" are identical.
  _replayPending: { message: true, thinking: true },
})

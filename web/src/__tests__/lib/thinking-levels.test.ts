import { describe, expect, it } from 'bun:test'
import type { ModelCatalogEntry } from '@/api/types'
import { pickableThinkingLevels } from '@/lib/thinking-levels'

function model(id: string, thinking_levels: string[]): ModelCatalogEntry {
  const [provider, name] = id.split(':')
  return { id, provider, model: name, vision: false, output_image: false, output_video: false, thinking_levels, summary_trigger_tokens: 0, fast_mode: false }
}

const models = [model('openai:gpt-5', ['low', 'high']), model('zai:glm-4.6', [])]

describe('pickableThinkingLevels', () => {
  it('offers the levels a known model declares', () => {
    expect(pickableThinkingLevels(models[0], true)).toEqual(['low', 'high'])
    expect(pickableThinkingLevels(model('a:b', ['__none__', 'low']), true)).toEqual(['low'])
  })

  it('offers nothing while the model list is a placeholder: its levels are not known yet', () => {
    // Placeholder rows (built from the providers list) carry no levels; a lone
    // "Off" would save `none` over the level the session has.
    expect(pickableThinkingLevels(model('openai:gpt-5', []), false)).toEqual([])
    expect(pickableThinkingLevels(models[0], false)).toEqual([])
  })

  it('offers nothing for a model with no levels, or one the registry does not list', () => {
    expect(pickableThinkingLevels(models[1], true)).toEqual([])
    expect(pickableThinkingLevels(undefined, true)).toEqual([])
    expect(pickableThinkingLevels(model('a:b', ['__none__']), true)).toEqual([])
    expect(pickableThinkingLevels(model('a:b', ['none']), true)).toEqual([])
  })
})

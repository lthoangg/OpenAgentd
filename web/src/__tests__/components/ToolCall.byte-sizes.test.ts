/**
 * Tool rows say sizes the way the rest of the app does (utils/format
 * formatBytes): one decimal, no trailing ".0", KB / MB / GB. They used two
 * private copies, one rounding to whole KB and one keeping "2.0 KB".
 */
import { describe, expect, it } from 'bun:test'

import { summarizeText } from '@/components/ToolCall/displayText'
import { toolRowSummary } from '@/components/ToolCall/summary'

describe('tool row sizes', () => {
  it('web_fetch says the fetched size with one decimal', () => {
    expect(toolRowSummary('web_fetch', 'x'.repeat(1536), false)?.text).toBe('1.5 KB')
    expect(toolRowSummary('web_fetch', 'x'.repeat(2048), false)?.text).toBe('2 KB')
    expect(toolRowSummary('web_fetch', 'x'.repeat(512), false)?.text).toBe('512 B')
  })

  it('a text summary drops the trailing ".0"', () => {
    expect(summarizeText('Output', 'a\n'.repeat(1024))).toBe('Output: 1,025 lines · 2 KB')
    expect(summarizeText('Output', null)).toBe('Output: empty')
  })
})

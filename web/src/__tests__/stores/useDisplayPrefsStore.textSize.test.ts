/**
 * Text size (Settings → Appearance): three steps, remembered per device and
 * applied to <html> as ``data-text-size`` so every rem type step scales with
 * ``--oa-text-scale`` (index.css). Default is a step above the old density;
 * Compact keeps it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DISPLAY_PREFS_STORAGE_KEY, TEXT_SIZES, applyTextSize, textSizeScale, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

afterEach(() => {
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed', textSize: 'default' })
  localStorage.removeItem(DISPLAY_PREFS_STORAGE_KEY)
  delete document.documentElement.dataset.textSize
})

describe('text size', () => {
  it('offers Compact, Default and Large, defaulting to Default', () => {
    expect(TEXT_SIZES.map((s) => s.label)).toEqual(['Compact', 'Default', 'Large'])
    expect(useDisplayPrefsStore.getState().textSize).toBe('default')
  })

  it('makes Default 13px UI text and Large 14px, with Compact at the old 12px', () => {
    expect(12 * textSizeScale('compact')).toBeCloseTo(12)
    expect(12 * textSizeScale('default')).toBeCloseTo(13)
    expect(12 * textSizeScale('large')).toBeCloseTo(14)
  })

  it('remembers a pick and applies it to the document', () => {
    useDisplayPrefsStore.getState().setTextSize('large')

    expect(document.documentElement.dataset.textSize).toBe('large')
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_STORAGE_KEY) ?? '{}').state).toEqual({ transcriptStyle: 'detailed', textSize: 'large' })
  })

  it('reads an unknown stored size as Default', async () => {
    localStorage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify({ state: { transcriptStyle: 'reader', textSize: 'huge' }, version: 0 }))

    await useDisplayPrefsStore.persist.rehydrate()

    expect(useDisplayPrefsStore.getState().textSize).toBe('default')
  })

  it('applies a size without touching the store', () => {
    applyTextSize('compact')
    expect(document.documentElement.dataset.textSize).toBe('compact')
  })

  it('scales every rem type step from one variable', () => {
    expect(css).toMatch(/--oa-text-scale:\s*calc\(13 \/ 12\)/)
    expect(css).toMatch(/\[data-text-size="compact"\]\s*\{\s*--oa-text-scale:\s*1;/)
    expect(css).toMatch(/\[data-text-size="large"\]\s*\{\s*--oa-text-scale:\s*calc\(14 \/ 12\);/)
    for (const step of ['xs', 'sm', 'base', 'lg', 'meta', 'code']) {
      expect({ step, scaled: new RegExp(`--text-${step}:\\s*calc\\([^;]*var\\(--oa-text-scale\\)\\)`).test(css) }).toEqual({ step, scaled: true })
    }
  })
})

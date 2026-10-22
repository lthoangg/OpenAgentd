/**
 * A streaming answer renders as settled chunks plus a live tail, so an
 * update re-renders only the tail. Rendered output must match a whole render.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
// Show each update at once instead of easing it in over animation frames.
mock.module('@/hooks/useSmoothStream', () => ({ useSmoothStream: (content: string) => content }))
const codeRenders = new Map<string, number>()
mock.module('@/components/FileRefLink', () => ({
  FileRefCode: ({ children }: { children: string }) => {
    codeRenders.set(children, (codeRenders.get(children) ?? 0) + 1)
    return <code>{children}</code>
  },
  MarkdownLink: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

import { MarkdownBlock } from '@/utils/markdown'

afterEach(() => {
  cleanup()
  codeRenders.clear()
})

function longAnswer(sections: number): string {
  const parts: string[] = ['Intro mentions `early_marker` once.', '']
  for (let i = 0; i < sections; i++) {
    parts.push(`## Step ${i}`, '', `Step ${i} keeps **four** decimals until the total, so the lines add up to the header.`.repeat(4), '',
      '- read it', '- test it', '', '```ts', `export const total${i} = 1`, '```', '', '| file | change |', '| --- | --- |', `| b/${i}.rs | r |`, '')
  }
  return parts.join('\n')
}

function streamInto(text: string, step: number) {
  const view = render(<MarkdownBlock content="" sessionId="s1" isStreaming />)
  let flushes = 0
  for (let n = step; n < text.length + step; n += step) {
    act(() => view.rerender(<MarkdownBlock content={text.slice(0, n)} sessionId="s1" isStreaming />))
    flushes++
  }
  return { ...view, flushes }
}

describe('MarkdownBlock — chunked streaming', () => {
  it('stops re-rendering earlier blocks once they settle', () => {
    const text = longAnswer(40)
    const { flushes } = streamInto(text, 50)
    expect(flushes).toBeGreaterThan(200)
    // Rendered while the intro was still the live tail, then left alone.
    expect(codeRenders.get('early_marker')!).toBeLessThan(60)
  })

  it('renders exactly what a whole render shows once the stream ends', () => {
    const text = longAnswer(30)
    const streamed = streamInto(text, 70)
    act(() => streamed.rerender(<MarkdownBlock content={text} sessionId="s1" isStreaming={false} />))
    const whole = render(<MarkdownBlock content={text} sessionId="s1" />)
    // `useId` values differ between two separate trees.
    const markup = (el: HTMLElement) => el.innerHTML.replace(/_r_[0-9a-z]+_/g, 'ID')
    expect(markup(streamed.container)).toBe(markup(whole.container))
  })

  it('keeps the elements of settled chunks when the stream ends', () => {
    const text = longAnswer(30)
    const { container, rerender } = streamInto(text, 70)
    const firstPre = container.querySelector('pre')
    expect(firstPre).not.toBeNull()
    act(() => rerender(<MarkdownBlock content={text} sessionId="s1" isStreaming={false} />))
    expect(container.querySelector('pre')).toBe(firstPre)
  })

  // A settled chunk is final, so its code is highlighted as it settles rather
  // than every block at once when the stream ends (a visible hitch on long
  // answers). Only the live tail stays plain while it is still being written.
  it('highlights code in settled chunks while the stream is still running', () => {
    const text = longAnswer(30)
    const { container } = streamInto(text.slice(0, Math.floor(text.length * 0.8)), 70)
    const firstPre = container.querySelector('pre')
    expect(firstPre).not.toBeNull()
    expect(firstPre!.querySelector('.th-token')).not.toBeNull()
  })

  // index.css draws the caret after the last text block of a streaming
  // answer; the attribute is what it keys on.
  it('marks a streaming answer for the live caret and drops the mark when it ends', () => {
    const { container, rerender } = streamInto('Working on **it**', 5)
    expect(container.querySelector('.oa-prose')!.hasAttribute('data-streaming')).toBe(true)
    act(() => rerender(<MarkdownBlock content="Working on **it**" sessionId="s1" isStreaming={false} />))
    expect(container.querySelector('.oa-prose')!.hasAttribute('data-streaming')).toBe(false)
  })
})

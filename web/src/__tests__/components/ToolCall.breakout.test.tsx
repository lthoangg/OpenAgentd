/**
 * An open tool row's details widen past the prose column (``[data-breakout]``
 * in index.css). The widened box must not sit inside a narrower box that clips
 * its overflow, or its text is cut off at the column's edges.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ToolCall } from '@/components/ToolCall'

afterEach(cleanup)

describe('an open tool row', () => {
  it('widens its details without a clipping box around them', () => {
    const { container } = render(
      <ToolCall name="custom_tool" args={JSON.stringify({ query: 'a long argument' })} done result="some result" />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Expand custom_tool details/ }))

    const breakout = container.querySelector('[data-breakout]')
    expect(breakout).not.toBeNull()
    const clipping: string[] = []
    for (let el = breakout?.parentElement; el && el !== container; el = el.parentElement) {
      if (/(^|\s)overflow-(hidden|clip|auto|x-hidden)(\s|$)/.test(el.className)) clipping.push(el.className)
    }
    expect(clipping).toEqual([])
  })
})

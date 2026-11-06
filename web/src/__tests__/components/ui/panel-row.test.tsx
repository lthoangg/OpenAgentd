/**
 * A switch row keeps its switch beside the label at every width, as iOS
 * Settings does (mockup J10); other controls still stack under a phone's
 * label.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { PanelRow } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'

afterEach(cleanup)

describe('PanelRow', () => {
  it('keeps a switch on the label line at every width', () => {
    const { container } = render(
      <PanelRow label="Allow questions" htmlFor="q" description="What it does.">
        <Switch id="q" checked={false} onCheckedChange={() => {}} />
      </PanelRow>,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className.split(/\s+/)).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(row.className).not.toContain('flex-col')
  })

  it('stacks other controls under the label on a phone', () => {
    const { container } = render(
      <PanelRow label="Name" htmlFor="n"><input id="n" /></PanelRow>,
    )
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).toContain('flex-col')
  })

  it('keeps an inline number and its unit on the label line at every width', () => {
    const { container } = render(
      <PanelRow label="Turns per goal" htmlFor="t" inline><input id="t" type="number" /><span>turns</span></PanelRow>,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className.split(/\s+/)).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(row.className).not.toContain('flex-col')
    expect(row.textContent).toContain('turns')
  })
})

describe('PanelRow footer', () => {
  it('runs the description under the label and the control, the full row wide', () => {
    const { container } = render(
      <PanelRow label="Turns per goal" htmlFor="t" inline description="What it does."><input id="t" type="number" /></PanelRow>,
    )
    const notes = (container.firstElementChild as HTMLElement).lastElementChild as HTMLElement
    expect(notes.textContent).toBe('What it does.')
    expect(notes.className.split(/\s+/)).toContain('col-span-2')
  })
})

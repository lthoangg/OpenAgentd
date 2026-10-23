import { afterEach, describe, expect, it } from 'bun:test'

import { useUIStore } from '@/stores/useUIStore'

function resetUIStore(): void {
  useUIStore.setState({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
    palettePage: [],
    quickOpenOpen: false,
    quickOpenQuery: '',
    telemetryOpen: false,
  })
}

afterEach(resetUIStore)

describe('useUIStore utility modals', () => {
  it('keeps only one utility modal open at a time', () => {
    useUIStore.getState().toggleScheduler()
    expect(useUIStore.getState().schedulerOpen).toBe(true)

    useUIStore.getState().toggleAgentCapabilities()
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(true)
  })

  it('closes the currently open modal when toggled again', () => {
    useUIStore.getState().toggleAgentCapabilities()
    useUIStore.getState().toggleAgentCapabilities()

    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(false)
    expect(useUIStore.getState().schedulerOpen).toBe(false)
  })

  it('togglePalette closes the other panels', () => {
    useUIStore.getState().toggleScheduler()
    expect(useUIStore.getState().schedulerOpen).toBe(true)

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(useUIStore.getState().schedulerOpen).toBe(false)
    expect(useUIStore.getState().agentCapabilitiesOpen).toBe(false)
  })

  it('keeps Quick Open and the Command Palette mutually exclusive', () => {
    useUIStore.getState().toggleQuickOpen()
    expect(useUIStore.getState().quickOpenOpen).toBe(true)

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState()).toMatchObject({
      quickOpenOpen: false,
      paletteOpen: true,
    })
  })

  it('opens Quick Open already searching for a query, closing the other panels', () => {
    useUIStore.getState().togglePalette()
    useUIStore.getState().openQuickOpen('Button.tsx:12')

    expect(useUIStore.getState()).toMatchObject({
      quickOpenOpen: true,
      quickOpenQuery: 'Button.tsx:12',
      paletteOpen: false,
    })
  })

  it('opens Quick Open empty from its shortcut after a searched opening', () => {
    useUIStore.getState().openQuickOpen('Button.tsx')
    useUIStore.getState().closeQuickOpen()
    useUIStore.getState().toggleQuickOpen()

    expect(useUIStore.getState()).toMatchObject({ quickOpenOpen: true, quickOpenQuery: '' })
  })

  it('closeAll resets all utility panels', () => {
    useUIStore.setState({ schedulerOpen: true, agentCapabilitiesOpen: true, paletteOpen: true, quickOpenOpen: true, telemetryOpen: true })
    useUIStore.getState().closeAll()
    expect(useUIStore.getState()).toMatchObject({
      schedulerOpen: false,
      agentCapabilitiesOpen: false,
      paletteOpen: false,
      quickOpenOpen: false,
      telemetryOpen: false,
    })
  })

  it('opening telemetry closes the other overlays, and they close it', () => {
    useUIStore.getState().toggleScheduler()
    useUIStore.getState().openTelemetry()
    expect(useUIStore.getState()).toMatchObject({ telemetryOpen: true, schedulerOpen: false })

    useUIStore.getState().togglePalette()
    expect(useUIStore.getState()).toMatchObject({ telemetryOpen: false, paletteOpen: true })
  })

  it('toggleTelemetry flips the overlay', () => {
    useUIStore.getState().toggleTelemetry()
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    useUIStore.getState().toggleTelemetry()
    expect(useUIStore.getState().telemetryOpen).toBe(false)
  })

  it('openPaletteAt opens the palette on a page, replacing an open one', () => {
    useUIStore.getState().togglePalette()
    const key = useUIStore.getState().paletteKey
    useUIStore.getState().openPaletteAt(['switch', 'workspace:/a'])
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(useUIStore.getState().palettePage).toEqual(['switch', 'workspace:/a'])
    expect(useUIStore.getState().paletteKey).toBe(key + 1)

    useUIStore.getState().openPaletteAt(['switch'])
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(useUIStore.getState().palettePage).toEqual(['switch'])
  })

  it('openPaletteAt closes the palette already open on that page', () => {
    useUIStore.getState().openPaletteAt(['switch'])
    useUIStore.getState().openPaletteAt(['switch'])
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('togglePalette opens on the root list', () => {
    useUIStore.getState().openPaletteAt(['switch'])
    useUIStore.getState().closePalette()
    useUIStore.getState().togglePalette()
    expect(useUIStore.getState().palettePage).toEqual([])
  })
})

import { afterEach, describe, expect, it } from 'bun:test'

import { useUIStore } from '@/stores/useUIStore'

function resetUIStore(): void {
  useUIStore.setState({
    schedulerOpen: false,
    agentCapabilitiesOpen: false,
    paletteOpen: false,
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

  it('closeAll resets all three panels', () => {
    useUIStore.setState({ schedulerOpen: true, agentCapabilitiesOpen: true, paletteOpen: true })
    useUIStore.getState().closeAll()
    expect(useUIStore.getState()).toMatchObject({
      schedulerOpen: false,
      agentCapabilitiesOpen: false,
      paletteOpen: false,
    })
  })
})

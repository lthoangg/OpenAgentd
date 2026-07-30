import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let isMacOverlay = false
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: isMacOverlay, os: isMacOverlay ? 'macos' : 'ios', isMacOverlay }),
}))

// Mock useThemePreference
mock.module('@/hooks/useThemePreference', () => ({
  useThemePreference: () => ({ resolved: 'light' }),
}))

// Mock mermaid
let renderCallCount = 0
mock.module('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (_id: string, source: string) => {
      renderCallCount++
      return { svg: `<svg data-testid="mermaid-svg">${source}</svg>` }
    },
  },
}))

import { MermaidBlock } from '@/utils/MermaidBlock'

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderCallCount = 0
    isMacOverlay = false
    // Mock navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mock(async () => {}),
      },
    })
  })

  it('renders a single header with Mermaid label, tabs, and copy button', async () => {
    const source = 'graph TD; A-->B;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)

    // Verify language label
    expect(screen.getByText('Mermaid')).toBeTruthy()

    // Verify tabs
    expect(screen.getByRole('tab', { name: 'Diagram' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Code' })).toBeTruthy()

    // Verify single copy button
    const copyButtons = screen.getAllByRole('button', { name: /copy code/i })
    expect(copyButtons.length).toBe(1)

    // Wait for diagram to render
    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })
  })

  it('does not duplicate headers when switching to the Code tab', async () => {
    const source = 'graph TD; A-->B;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })

    // Switch to Code tab
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))

    // Verify still only 1 copy button in header
    const copyButtons = screen.getAllByRole('button', { name: /copy code/i })
    expect(copyButtons.length).toBe(1)

    // Verify code tab is showing source
    expect(screen.getByText(source)).toBeTruthy()
  })

  it('caches diagram rendered result and avoids re-rendering on tab switch', async () => {
    const source = 'graph TD; X-->Y;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })

    const initialCalls = renderCallCount

    // Toggle tabs back and forth
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Diagram' }))

    // Render count should NOT increase when toggling tabs
    expect(renderCallCount).toBe(initialCalls)
  })

  it('copies diagram source code to clipboard when copy button is clicked', async () => {
    const source = 'graph TD; C-->D;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })

    const copyButton = screen.getByRole('button', { name: /copy code/i })
    fireEvent.click(copyButton)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(source)
  })

  it('keeps the full screen lightbox gesture-first without zoom chrome or text selection', async () => {
    const source = 'graph TD; ZoomA-->ZoomB;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)
    await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /full screen/i }))
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Zoom out' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull()
    expect(screen.queryByRole('status', { name: 'Zoom level' })).toBeNull()
    expect(screen.getByRole('dialog', { name: /mermaid diagram full screen/i }).className).toContain('select-none')
  })

  it('keeps the full screen header below the iOS safe area', async () => {
    const source = 'graph TD; SafeAreaA-->SafeAreaB;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)
    await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /full screen/i }))
    const header = screen.getByRole('banner')

    expect(header.className).toContain('mobile-safe-header')
    expect(header.className).not.toContain('pl-(--spacing-mac-traffic-inset)')
  })

  it('positions the full screen header below the macOS overlay title bar', async () => {
    isMacOverlay = true
    const source = 'graph TD; TrafficA-->TrafficB;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)
    await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /full screen/i }))
    const header = screen.getByRole('banner')

    expect(header.className).toContain('top-(--spacing-app-header)')
    expect(header.className).not.toContain('pl-(--spacing-mac-traffic-inset)')
  })

  it('uses fine-grained wheel zoom in the full screen lightbox', async () => {
    const source = 'graph TD; WheelA-->WheelB;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)
    await waitFor(() => expect(screen.getByTestId('mermaid-svg')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /full screen/i }))
    const diagram = document.querySelector('.oa-mermaid-lightbox-content > div') as HTMLElement
    diagram.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 200, width: 200, height: 200, toJSON: () => ({}),
    })
    fireEvent.wheel(diagram, { deltaY: -100, clientX: 100, clientY: 100 })

    expect(diagram.style.transform).toContain('scale(1.1)')
  })

  it('opens full screen lightbox popup when full screen button is clicked', async () => {
    const source = 'graph TD; FS1-->FS2;'
    render(<MermaidBlock source={source} highlightedCode={<span>{source}</span>} />)

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })

    const fullScreenBtn = screen.getByRole('button', { name: /full screen/i })
    expect(fullScreenBtn).toBeTruthy()

    fireEvent.click(fullScreenBtn)

    // Verify lightbox dialog is opened
    const dialog = screen.getByRole('dialog', { name: /mermaid diagram full screen/i })
    expect(dialog).toBeTruthy()

    // Close lightbox
    const closeBtn = screen.getByRole('button', { name: /close full screen/i })
    fireEvent.click(closeBtn)

    expect(screen.queryByRole('dialog', { name: /mermaid diagram full screen/i })).toBeNull()
  })
})

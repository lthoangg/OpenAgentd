import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => ({
  File: () => null,
  Loader2: () => null,
}))

let rejectRender = false
const getPage = mock(async (...args: unknown[]) => {
  const pageNumber = args[0] as number
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
    render: () => ({ promise: rejectRender ? Promise.reject(new Error('render failed')) : Promise.resolve(), cancel: () => {} }),
    cleanup: () => {},
    pageNumber,
  }
})
const destroy = mock(() => {})

mock.module('@/lib/pdfjs-loader', () => ({
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 100, getPage }),
      destroy,
    }),
  }),
}))

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  readonly observed: Element[] = []
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockIntersectionObserver.instances.push(this)
  }
  observe(element: Element) { this.observed.push(element) }
  unobserve() {}
  disconnect() {}
  intersect(element: Element) {
    this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

describe('PdfDocumentViewer', () => {
  beforeEach(() => {
    getPage.mockClear()
    destroy.mockClear()
    rejectRender = false
    MockIntersectionObserver.instances = []
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) })
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: MockIntersectionObserver })
  })

  afterEach(cleanup)

  it('renders only initial pages, then renders observed placeholders', async () => {
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    const { container } = render(<PdfDocumentViewer src="large.pdf" className="h-96" />)

    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    expect(container.querySelectorAll('[data-pdf-page]').length).toBe(100)
    expect(container.querySelector('[data-pdf-page="10"]')).not.toBeNull()

    await act(async () => {
      MockIntersectionObserver.instances[0]?.intersect(container.querySelector('[data-pdf-page="10"]')!)
    })
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(10))
  })

  it('reserves default page geometry for every placeholder', async () => {
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    const { container } = render(<PdfDocumentViewer src="large.pdf" />)

    await waitFor(() => expect(container.querySelectorAll('[data-pdf-page]').length).toBe(100))
    const placeholder = container.querySelector<HTMLElement>('[data-pdf-page="50"]')!
    expect(placeholder.style.width).toBe('100%')
    expect(placeholder.style.maxWidth).toBe('900px')
    expect(placeholder.style.aspectRatio).toBe('8.5 / 11')
  })

  it('does not restart initial page renders after the first page marks ready', async () => {
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    render(<PdfDocumentViewer src="large.pdf" />)

    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(getPage).toHaveBeenCalledTimes(2)
  })

  it('exposes loading status and semantic page regions', async () => {
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    const { container, getByRole } = render(<PdfDocumentViewer src="large.pdf" />)

    expect(getByRole('status').getAttribute('aria-busy')).toBe('true')
    await waitFor(() => expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(100))
    expect(container.querySelector('[role="list"]')).not.toBeNull()
    expect(container.querySelector('[role="listitem"]')?.getAttribute('aria-label')).toBe('Page 1 of 100')
  })

  it('announces an error when the first page render rejects', async () => {
    rejectRender = true
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    const { getByRole, queryByRole } = render(<PdfDocumentViewer src="large.pdf" />)

    await waitFor(() => expect(getByRole('alert').textContent).toContain("Couldn't render this PDF"))
    expect(queryByRole('status')).toBeNull()
  })

  it('cancels page renders and destroys the document on unmount', async () => {
    const { PdfDocumentViewer } = await import('@/components/PdfDocumentViewer')
    const { unmount } = render(<PdfDocumentViewer src="large.pdf" />)

    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(2))
    unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

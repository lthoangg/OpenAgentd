import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useImageReveal } from '@/hooks/useImageReveal'

function Img({ src }: { src: string }) {
  const { ref, reveal, revealProps } = useImageReveal(src)
  return (
    <img
      ref={ref}
      src={src}
      alt="x"
      data-revealed={revealProps['data-revealed']}
      className={revealProps.className}
      onLoad={reveal}
      onError={reveal}
    />
  )
}

async function flush() {
  await act(() => new Promise((r) => setTimeout(r, 0)))
}

describe('useImageReveal', () => {
  afterEach(cleanup)

  it('holds an image hidden until it has loaded', async () => {
    const { container } = render(<Img src="a.png" />)
    const img = container.querySelector('img')!
    expect(img.className).toContain('oa-img-reveal')
    expect(img.hasAttribute('data-revealed')).toBe(false)
    fireEvent.load(img)
    await flush()
    expect(img.hasAttribute('data-revealed')).toBe(true)
  })

  it('reveals a broken image rather than leaving a hole', async () => {
    const { container } = render(<Img src="a.png" />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    await flush()
    expect(img.hasAttribute('data-revealed')).toBe(true)
  })

  it('hides again for a new source', async () => {
    const { container, rerender } = render(<Img src="a.png" />)
    fireEvent.load(container.querySelector('img')!)
    await flush()
    rerender(<Img src="b.png" />)
    expect(container.querySelector('img')!.hasAttribute('data-revealed')).toBe(false)
  })
})

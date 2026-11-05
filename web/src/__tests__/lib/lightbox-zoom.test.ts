import { afterEach, describe, expect, it } from 'bun:test'
import { findThumbnail, zoomInFrom } from '@/lib/lightbox-zoom'

function place(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}),
  }) as DOMRect
}

afterEach(() => { document.body.innerHTML = '' })

describe('lightbox zoom', () => {
  it('finds the on-screen thumbnail of an image, never the lightbox copy', () => {
    document.body.innerHTML = '<div data-lightbox=""><img src="/a.png"></div><img id="thumb" src="/a.png">'
    const [inBox, thumb] = Array.from(document.querySelectorAll('img'))
    place(inBox, { left: 0, top: 0, width: 800, height: 600 })
    place(thumb, { left: 10, top: 20, width: 100, height: 75 })
    expect(findThumbnail('/a.png')).toBe(thumb)
  })

  it('finds nothing for a thumbnail scrolled off screen', () => {
    document.body.innerHTML = '<img src="/a.png">'
    place(document.querySelector('img')!, { left: 10, top: -500, width: 100, height: 75 })
    expect(findThumbnail('/a.png')).toBeNull()
  })

  it('grows the image from the thumbnail: centre on centre, one scale', () => {
    document.body.innerHTML = '<img id="thumb" src="/a.png"><div data-lightbox=""><img id="big" src="/a.png"></div>'
    const thumb = document.getElementById('thumb') as HTMLImageElement
    const big = document.getElementById('big') as HTMLImageElement
    place(thumb, { left: 0, top: 0, width: 100, height: 100 })
    place(big, { left: 100, top: 100, width: 400, height: 400 })
    let frames: Keyframe[] = []
    big.animate = ((f: Keyframe[]) => {
      frames = f
      return { finished: Promise.resolve() } as unknown as Animation
    }) as typeof big.animate
    expect(zoomInFrom(big, '/a.png')).toBe(true)
    expect(frames[0].transform).toBe('translate(-250px, -250px) scale(0.25)')
    expect(frames[1].transform).toBe('none')
  })

  it('does not zoom without a thumbnail', () => {
    document.body.innerHTML = '<div data-lightbox=""><img id="big" src="/a.png"></div>'
    const big = document.getElementById('big') as HTMLImageElement
    place(big, { left: 0, top: 0, width: 400, height: 400 })
    expect(zoomInFrom(big, '/a.png')).toBe(false)
  })
})

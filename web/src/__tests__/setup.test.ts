/**
 * What the suite's own setup (setup.ts) has to keep true for every test.
 */
import { describe, expect, it } from 'bun:test'

describe('a failed assertion on DOM nodes', () => {
  it('prints each node as its opening tag, not as an object graph', () => {
    document.body.innerHTML = '<button aria-label="Save" class="primary">Save</button>'
    const button = document.querySelector('button')

    let message = ''
    try {
      expect(document.body).toBe(button)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Expected: <button aria-label="Save" class="primary">')
    expect(message).toContain('Received: <body>')
    // Printed as objects, the two nodes take seconds and hundreds of megabytes.
    expect(message.length).toBeLessThan(500)
  })

  it('names a node that is not an element', () => {
    let message = ''
    try {
      expect(document.createTextNode('hello')).toBe(document)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Expected: #document')
    expect(message).toContain('Received: #text')
  })
})

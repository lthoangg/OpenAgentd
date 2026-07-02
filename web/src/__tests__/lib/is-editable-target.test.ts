import { describe, it, expect, afterEach } from 'bun:test'
import { isEditableTarget } from '@/lib/is-editable-target'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isEditableTarget', () => {
  it('returns false for non-element targets', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
  })

  it('returns false for a plain div', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(isEditableTarget(div)).toBe(false)
  })

  it('returns true for an <input>', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(isEditableTarget(input)).toBe(true)
  })

  it('returns true for a <textarea>', () => {
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    expect(isEditableTarget(textarea)).toBe(true)
  })

  it('returns true for a <select>', () => {
    const select = document.createElement('select')
    document.body.appendChild(select)
    expect(isEditableTarget(select)).toBe(true)
  })

  it('returns true for contenteditable elements', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    expect(isEditableTarget(div)).toBe(true)
  })

  it('returns true for isContentEditable via property', () => {
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    document.body.appendChild(div)
    expect(isEditableTarget(div)).toBe(true)
  })

  it('returns true for a child of a data-scroll-capture container', () => {
    const container = document.createElement('div')
    container.setAttribute('data-scroll-capture', '')
    const child = document.createElement('span')
    container.appendChild(child)
    document.body.appendChild(container)
    expect(isEditableTarget(child)).toBe(true)
  })

  it('returns true for a nested child of a focused input wrapper', () => {
    const wrapper = document.createElement('div')
    const input = document.createElement('input')
    wrapper.appendChild(input)
    document.body.appendChild(wrapper)
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(wrapper)).toBe(false)
  })
})

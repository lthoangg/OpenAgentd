import { describe, expect, it } from 'bun:test'

import { kindNoun, nearbyPhoneName, otherPhoneName } from '@/lib/device-words'

describe('device words', () => {
  it('names the phone that adds this one', () => {
    expect(otherPhoneName('iPhone', false)).toBe('your other iPhone')
    expect(otherPhoneName('iPad', false)).toBe('your iPhone')
    // An Android phone may be added by an iPhone or another Android phone.
    expect(otherPhoneName('phone', true)).toBe('your other phone')
  })

  it('names the phone in "No … nearby?"', () => {
    expect(nearbyPhoneName(false)).toBe('iPhone')
    expect(nearbyPhoneName(true)).toBe('other phone')
  })

  it('names an Android device in the account', () => {
    expect(kindNoun('android')).toBe('Android phone')
  })
})
